import { access, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

export type RuntimeLifecyclePhase = "install" | "remove" | "update"
export type RuntimeComponentType =
  | "runtime"
  | "package"
  | "bundled-runtime"
  | "released-service"

export interface RuntimePackageCatalogEntry {
  id?: string
  packageName: string
  installSpec: string
  binName?: string
}

export interface RuntimeComponentDefinition {
  name: string
  type: RuntimeComponentType
  source?: string
  version?: string
  channelVersion?: string
  runtimeDataDir?: string
  lifecycleDependencies: string[]
  packageCatalog: RuntimePackageCatalogEntry[]
  pm2?: RuntimePm2ServiceDefinition
  releasedService?: RuntimeReleasedServiceDefinition
  scripts: {
    install: string
    verify?: string
    configure?: string
    update?: string
    remove?: string
  }
}

export interface RuntimePhaseDefinition {
  order: string[]
  reverse: boolean
}

export interface RuntimeManifestPaths {
  runtimeRoot: string
  runtimeHome: string
  runtimeDataRoot: string
  bin: string
  config: string
  logs: string
  data: string
  stateFile: string
  componentsRoot: string
  componentDataRoot: string
  defaultPm2Home: string
  npmPrefix: string
  nodeRuntime: string
  dotnetRuntime: string
  vendoredRoot: string
}

export interface RuntimePm2ServiceDefinition {
  appName?: string
  cwd?: string
  script?: string
  args?: string[]
  env?: Record<string, string>
  pm2Home?: string
}

export interface RuntimeReleasedServiceDefinition {
  dllPath: string
  workingDirectory: string
  configRoot?: string
  runtimeFilesDir?: string
  startScript?: string
}

export interface LoadedRuntimeManifest {
  manifestPath: string
  manifestDir: string
  runtime: {
    name: string
    version: string
  }
  components: RuntimeComponentDefinition[]
  componentMap: ReadonlyMap<string, RuntimeComponentDefinition>
  phases: Record<RuntimeLifecyclePhase, RuntimePhaseDefinition>
  paths: RuntimeManifestPaths
}

export interface LoadRuntimeManifestOptions {
  manifestPath?: string
}

export class RuntimeManifestValidationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`Runtime manifest validation failed: ${errors.join("; ")}`)
    this.name = "RuntimeManifestValidationError"
    this.errors = errors
  }
}

const supportedComponentTypes = new Set<RuntimeComponentType>([
  "runtime",
  "package",
  "bundled-runtime",
  "released-service"
])

export function getPackageRoot(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..")
}

export function getDefaultRuntimeManifestPath(moduleUrl = import.meta.url): string {
  return join(getPackageRoot(moduleUrl), "runtime", "manifest.yaml")
}

export async function loadRuntimeManifest(
  options: LoadRuntimeManifestOptions = {}
): Promise<LoadedRuntimeManifest> {
  const manifestPath = resolve(options.manifestPath ?? getDefaultRuntimeManifestPath())
  let parsed: unknown

  try {
    parsed = parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RuntimeManifestValidationError([
      `Failed to read runtime manifest ${manifestPath}: ${message}`
    ])
  }

  const manifest = validateRuntimeManifest(parsed, manifestPath)

  for (const component of manifest.components) {
    await validateRuntimeAssetExists(component.scripts.install)

    for (const candidate of [
      component.scripts.verify,
      component.scripts.configure,
      component.scripts.update,
      component.scripts.remove
    ]) {
      if (!candidate) {
        continue
      }

      await validateRuntimeAssetExists(candidate)
    }
  }

  return manifest
}

export async function validateRuntimeAssetExists(pathValue: string): Promise<void> {
  await access(pathValue)
}

function validateRuntimeManifest(
  value: unknown,
  manifestPath: string
): LoadedRuntimeManifest {
  const manifestDir = dirname(manifestPath)
  const errors: string[] = []

  if (!isRecord(value)) {
    throw new RuntimeManifestValidationError(["manifest must be a YAML object"])
  }

  const runtimeObject = toRecord(value.runtime, "runtime", errors)
  const pathsObject = toRecord(value.paths, "paths", errors)
  const phasesObject = toRecord(value.phases, "phases", errors)
  const componentValues = Array.isArray(value.components) ? value.components : null

  if (!componentValues) {
    errors.push("components must be an array")
  }

  const runtime = {
    name: readRequiredString(runtimeObject.name, "runtime.name", errors),
    version: readRequiredString(runtimeObject.version, "runtime.version", errors)
  }
  const paths = {
    runtimeRoot: readRequiredString(pathsObject.runtimeRoot, "paths.runtimeRoot", errors),
    runtimeHome: readOptionalString(pathsObject.runtimeHome, "paths.runtimeHome", errors) ?? "program",
    runtimeDataRoot:
      readOptionalString(pathsObject.runtimeDataRoot, "paths.runtimeDataRoot", errors) ??
      "runtime-data",
    bin: readRequiredString(pathsObject.bin, "paths.bin", errors),
    config: readRequiredString(pathsObject.config, "paths.config", errors),
    logs: readRequiredString(pathsObject.logs, "paths.logs", errors),
    data: readRequiredString(pathsObject.data, "paths.data", errors),
    stateFile: readRequiredString(pathsObject.stateFile, "paths.stateFile", errors),
    componentsRoot: readRequiredString(pathsObject.componentsRoot, "paths.componentsRoot", errors),
    componentDataRoot:
      readOptionalString(pathsObject.componentDataRoot, "paths.componentDataRoot", errors) ??
      "components",
    defaultPm2Home:
      readOptionalString(pathsObject.defaultPm2Home, "paths.defaultPm2Home", errors) ?? "pm2",
    npmPrefix: readRequiredString(pathsObject.npmPrefix, "paths.npmPrefix", errors),
    nodeRuntime: readRequiredString(pathsObject.nodeRuntime, "paths.nodeRuntime", errors),
    dotnetRuntime: readRequiredString(pathsObject.dotnetRuntime, "paths.dotnetRuntime", errors),
    vendoredRoot: readRequiredString(pathsObject.vendoredRoot, "paths.vendoredRoot", errors)
  }
  const phases = validateRuntimePhases(phasesObject, errors)
  const components = validateRuntimeComponents(componentValues ?? [], manifestDir, errors)
  const componentMap = new Map<string, RuntimeComponentDefinition>()

  for (const component of components) {
    if (componentMap.has(component.name)) {
      errors.push(`components contains duplicate name ${component.name}`)
      continue
    }

    componentMap.set(component.name, component)
  }

  for (const component of components) {
    for (const dependencyName of component.lifecycleDependencies) {
      if (!componentMap.has(dependencyName)) {
        errors.push(`component ${component.name} references unknown lifecycle dependency ${dependencyName}`)
      }
    }
  }

  for (const [phaseName, definition] of Object.entries(phases) as Array<
    [RuntimeLifecyclePhase, RuntimePhaseDefinition]
  >) {
    for (const componentName of definition.order) {
      if (!componentMap.has(componentName)) {
        errors.push(
          `phases.${phaseName}.order references unknown component ${componentName}`
        )
      }
    }
  }

  if (errors.length > 0) {
    throw new RuntimeManifestValidationError(errors)
  }

  return {
    manifestPath,
    manifestDir,
    runtime,
    components,
    componentMap,
    phases,
    paths
  }
}

function validateRuntimePhases(
  value: Record<string, unknown>,
  errors: string[]
): Record<RuntimeLifecyclePhase, RuntimePhaseDefinition> {
  return {
    install: validateRuntimePhase(value.install, "install", errors),
    remove: validateRuntimePhase(value.remove, "remove", errors),
    update: validateRuntimePhase(value.update, "update", errors)
  }
}

function validateRuntimePhase(
  value: unknown,
  phaseName: RuntimeLifecyclePhase,
  errors: string[]
): RuntimePhaseDefinition {
  const phaseObject = toRecord(value, `phases.${phaseName}`, errors)
  const orderValue = phaseObject.order
  const order = Array.isArray(orderValue)
    ? orderValue.filter((item): item is string => typeof item === "string")
    : []

  if (!Array.isArray(orderValue) || order.length !== orderValue.length || order.length === 0) {
    errors.push(`phases.${phaseName}.order must be a non-empty string array`)
  }

  const reverseValue = phaseObject.reverse
  if (reverseValue !== undefined && typeof reverseValue !== "boolean") {
    errors.push(`phases.${phaseName}.reverse must be a boolean when provided`)
  }

  return {
    order,
    reverse: reverseValue === true
  }
}

function validateRuntimeComponents(
  values: unknown[],
  manifestDir: string,
  errors: string[]
): RuntimeComponentDefinition[] {
  const components: RuntimeComponentDefinition[] = []

  for (const [index, value] of values.entries()) {
    const componentObject = toRecord(value, `components[${index}]`, errors)
    const name = readRequiredString(componentObject.name, `components[${index}].name`, errors)
    const rawType = readRequiredString(componentObject.type, `components[${index}].type`, errors)

    if (!supportedComponentTypes.has(rawType as RuntimeComponentType)) {
      errors.push(
        `components[${index}].type must be one of runtime, package, bundled-runtime, released-service`
      )
    }

    const installScript = readResolvedScript(
      componentObject.installScript,
      manifestDir,
      `components[${index}].installScript`,
      errors
    )
    const verifyScript = readOptionalResolvedScript(
      componentObject.verifyScript,
      manifestDir,
      `components[${index}].verifyScript`,
      errors
    )
    const configureScript = readOptionalResolvedScript(
      componentObject.configureScript,
      manifestDir,
      `components[${index}].configureScript`,
      errors
    )
    const updateScript = readOptionalResolvedScript(
      componentObject.updateScript,
      manifestDir,
      `components[${index}].updateScript`,
      errors
    )
    const removeScript = readOptionalResolvedScript(
      componentObject.removeScript,
      manifestDir,
      `components[${index}].removeScript`,
      errors
    )

    const packageCatalogValue = componentObject.packageCatalog
    const packageCatalog = Array.isArray(packageCatalogValue)
      ? packageCatalogValue.flatMap((entry, packageIndex) =>
          validateRuntimePackageCatalogEntry(
            entry,
            `components[${index}].packageCatalog[${packageIndex}]`,
            errors
          )
        )
      : []

    if (packageCatalogValue !== undefined && !Array.isArray(packageCatalogValue)) {
      errors.push(`components[${index}].packageCatalog must be an array when provided`)
    }

    const lifecycleDependenciesValue = componentObject.lifecycleDependencies
    const lifecycleDependencies = Array.isArray(lifecycleDependenciesValue)
      ? lifecycleDependenciesValue.filter((item): item is string => typeof item === "string")
      : []

    if (
      lifecycleDependenciesValue !== undefined &&
      (!Array.isArray(lifecycleDependenciesValue) ||
        lifecycleDependencies.length !== lifecycleDependenciesValue.length)
    ) {
      errors.push(`components[${index}].lifecycleDependencies must be a string array when provided`)
    }

    const releasedService = validateRuntimeReleasedServiceDefinition(
      componentObject.releasedService,
      `components[${index}].releasedService`,
      errors
    )

    if (rawType === "released-service" && !releasedService) {
      errors.push(`components[${index}].releasedService must be defined for released-service components`)
    }

    if (rawType === "released-service" && !componentObject.pm2) {
      errors.push(`components[${index}].pm2 must be defined for released-service components`)
    }

    components.push({
      name,
      type: rawType as RuntimeComponentType,
      source: readOptionalString(componentObject.source, `components[${index}].source`, errors),
      version: readOptionalString(componentObject.version, `components[${index}].version`, errors),
      channelVersion: readOptionalString(
        componentObject.channelVersion,
        `components[${index}].channelVersion`,
        errors
      ),
      runtimeDataDir: readOptionalString(
        componentObject.runtimeDataDir,
        `components[${index}].runtimeDataDir`,
        errors
      ),
      lifecycleDependencies,
      packageCatalog,
      pm2: validateRuntimePm2Definition(
        componentObject.pm2,
        `components[${index}].pm2`,
        errors
      ),
      releasedService,
      scripts: {
        install: installScript,
        verify: verifyScript,
        configure: configureScript,
        update: updateScript,
        remove: removeScript
      }
    })
  }

  return components
}

function validateRuntimePackageCatalogEntry(
  value: unknown,
  label: string,
  errors: string[]
): RuntimePackageCatalogEntry[] {
  const entryObject = toRecord(value, label, errors)
  const packageName = readRequiredString(
    entryObject.packageName,
    `${label}.packageName`,
    errors
  )
  const installSpec = readRequiredString(
    entryObject.installSpec,
    `${label}.installSpec`,
    errors
  )

  return [
    {
      id: readOptionalString(entryObject.id, `${label}.id`, errors),
      packageName,
      installSpec,
      binName: readOptionalString(entryObject.binName, `${label}.binName`, errors)
    }
  ]
}

function validateRuntimePm2Definition(
  value: unknown,
  label: string,
  errors: string[]
): RuntimePm2ServiceDefinition | undefined {
  if (value === undefined) {
    return undefined
  }

  const pm2Object = toRecord(value, label, errors)
  const argsValue = pm2Object.args
  const envValue = pm2Object.env
  const args = Array.isArray(argsValue)
    ? argsValue.filter((item): item is string => typeof item === "string")
    : undefined

  if (argsValue !== undefined && (!Array.isArray(argsValue) || args?.length !== argsValue.length)) {
    errors.push(`${label}.args must be a string array when provided`)
  }

  let env: Record<string, string> | undefined
  if (envValue !== undefined) {
    if (!isRecord(envValue)) {
      errors.push(`${label}.env must be an object when provided`)
    } else {
      env = {}
      for (const [key, entryValue] of Object.entries(envValue)) {
        if (typeof entryValue !== "string") {
          errors.push(`${label}.env.${key} must be a string`)
          continue
        }

        env[key] = entryValue
      }
    }
  }

  return {
    appName: readOptionalString(pm2Object.appName, `${label}.appName`, errors),
    cwd: readOptionalString(pm2Object.cwd, `${label}.cwd`, errors),
    script: readOptionalString(pm2Object.script, `${label}.script`, errors),
    args,
    env,
    pm2Home: readOptionalString(pm2Object.pm2Home, `${label}.pm2Home`, errors)
  }
}

function validateRuntimeReleasedServiceDefinition(
  value: unknown,
  label: string,
  errors: string[]
): RuntimeReleasedServiceDefinition | undefined {
  if (value === undefined) {
    return undefined
  }

  const releasedServiceObject = toRecord(value, label, errors)
  return {
    dllPath: readRequiredString(releasedServiceObject.dllPath, `${label}.dllPath`, errors),
    workingDirectory: readRequiredString(
      releasedServiceObject.workingDirectory,
      `${label}.workingDirectory`,
      errors
    ),
    configRoot: readOptionalString(releasedServiceObject.configRoot, `${label}.configRoot`, errors),
    runtimeFilesDir: readOptionalString(
      releasedServiceObject.runtimeFilesDir,
      `${label}.runtimeFilesDir`,
      errors
    ),
    startScript: readOptionalString(
      releasedServiceObject.startScript,
      `${label}.startScript`,
      errors
    )
  }
}

function toRecord(
  value: unknown,
  label: string,
  errors: string[]
): Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`)
    return {}
  }

  return value
}

function readRequiredString(
  value: unknown,
  label: string,
  errors: string[]
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string`)
    return ""
  }

  return value.trim()
}

function readOptionalString(
  value: unknown,
  label: string,
  errors: string[]
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string when provided`)
    return undefined
  }

  return value.trim()
}

function readResolvedScript(
  value: unknown,
  manifestDir: string,
  label: string,
  errors: string[]
): string {
  const scriptPath = readRequiredString(value, label, errors)
  return scriptPath ? resolveManifestRelativePath(manifestDir, scriptPath) : ""
}

function readOptionalResolvedScript(
  value: unknown,
  manifestDir: string,
  label: string,
  errors: string[]
): string | undefined {
  const scriptPath = readOptionalString(value, label, errors)
  return scriptPath ? resolveManifestRelativePath(manifestDir, scriptPath) : undefined
}

function resolveManifestRelativePath(manifestDir: string, scriptPath: string): string {
  return resolve(manifestDir, scriptPath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
