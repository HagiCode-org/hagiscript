import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parse, stringify } from "yaml"
import {
  getDefaultRuntimeManifestPath,
  loadRuntimeManifest,
  type LoadedRuntimeManifest
} from "./runtime-manifest.js"

const DEFAULT_INIT_MANIFEST_PATH = "hagiscript.manifest.yaml"

export interface RuntimeManifestPathUpdates {
  runtimeRoot?: string
  runtimeHome?: string
  runtimeDataRoot?: string
  serverProgramRoot?: string
  serverDataRoot?: string
}

export interface RuntimeManifestNpmPackageUpdate {
  packageName: string
  version: string
  target?: string
}

export interface RuntimeManifestMutationOptions {
  manifestPath: string
  pathUpdates?: RuntimeManifestPathUpdates
  npmPackageUpdates?: readonly RuntimeManifestNpmPackageUpdate[]
  serverActiveVersion?: string
}

export interface InitRuntimeManifestOptions extends RuntimeManifestMutationOptions {
  force?: boolean
}

export interface RuntimeManifestMutationResult {
  manifestPath: string
  manifest: LoadedRuntimeManifest
  changedFields: string[]
}

export interface RuntimeManifestSummary {
  manifestPath: string
  runtime: {
    name: string
    version: string
    hagicodeInstance?: string
  }
  paths: RuntimeManifestPathUpdates & {
    runtimeRoot: string
    runtimeHome: string
    runtimeDataRoot: string
    serverProgramRoot?: string
    serverDataRoot?: string
    npmPrefix?: string
  }
  serverActiveVersion?: string
  components: string[]
  npmPackages: Array<{
    packageName: string
    version?: string
    target?: string
  }>
}

export class RuntimeManifestMutationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuntimeManifestMutationError"
  }
}

export async function initRuntimeManifest(
  options: InitRuntimeManifestOptions = { manifestPath: DEFAULT_INIT_MANIFEST_PATH }
): Promise<RuntimeManifestMutationResult> {
  const manifestPath = resolve(options.manifestPath || DEFAULT_INIT_MANIFEST_PATH)
  if (!(options.force ?? false) && (await fileExists(manifestPath))) {
    throw new RuntimeManifestMutationError(
      `Manifest already exists: ${manifestPath}. Use --force to overwrite it.`
    )
  }

  const defaultManifestPath = getDefaultRuntimeManifestPath()
  const manifestObject = await readRuntimeManifestObject(defaultManifestPath)
  materializePackagedScriptPaths(manifestObject, dirname(defaultManifestPath))
  const changedFields = applyRuntimeManifestUpdates(manifestObject, {
    pathUpdates: options.pathUpdates,
    npmPackageUpdates: options.npmPackageUpdates,
    serverActiveVersion: options.serverActiveVersion
  })

  await writeRuntimeManifestObject(manifestPath, manifestObject)
  const manifest = await loadRuntimeManifest({ manifestPath })
  return {
    manifestPath,
    manifest,
    changedFields
  }
}

export async function updateRuntimeManifest(
  options: RuntimeManifestMutationOptions
): Promise<RuntimeManifestMutationResult> {
  const manifestPath = resolve(options.manifestPath)
  const manifestObject = await readRuntimeManifestObject(manifestPath)
  const changedFields = applyRuntimeManifestUpdates(manifestObject, options)

  if (changedFields.length === 0) {
    throw new RuntimeManifestMutationError("No manifest changes requested.")
  }

  await writeRuntimeManifestObject(manifestPath, manifestObject)
  const manifest = await loadRuntimeManifest({ manifestPath })
  return {
    manifestPath,
    manifest,
    changedFields
  }
}

export async function readRuntimeManifestSummary(
  manifestPath?: string
): Promise<RuntimeManifestSummary> {
  const manifest = await loadRuntimeManifest({ manifestPath })
  const serverComponent = manifest.componentMap.get("server")
  const packages = readManifestNpmPackages(manifest.npmSync)

  return {
    manifestPath: manifest.manifestPath,
    runtime: {
      name: manifest.runtime.name,
      version: manifest.runtime.version,
      hagicodeInstance: manifest.runtime.hagicodeInstance
    },
    paths: {
      runtimeRoot: manifest.paths.runtimeRoot,
      runtimeHome: manifest.paths.runtimeHome,
      runtimeDataRoot: manifest.paths.runtimeDataRoot,
      serverProgramRoot: manifest.paths.serverProgramRoot,
      serverDataRoot: manifest.paths.serverDataRoot,
      npmPrefix: manifest.paths.npmPrefix
    },
    serverActiveVersion: serverComponent?.releasedService?.activeVersion,
    components: manifest.components.map((component) => component.name),
    npmPackages: packages
  }
}

export function renderRuntimeManifestSummaryText(
  summary: RuntimeManifestSummary
): string {
  return [
    "Manifest.",
    `Path: ${summary.manifestPath}`,
    `Runtime: ${summary.runtime.name}@${summary.runtime.version}`,
    `Instance: ${summary.runtime.hagicodeInstance ?? "(none)"}`,
    "Paths:",
    `  runtimeRoot: ${summary.paths.runtimeRoot}`,
    `  runtimeHome: ${summary.paths.runtimeHome}`,
    `  runtimeDataRoot: ${summary.paths.runtimeDataRoot}`,
    `  serverProgramRoot: ${summary.paths.serverProgramRoot ?? "(default)"}`,
    `  serverDataRoot: ${summary.paths.serverDataRoot ?? "(default)"}`,
    `  npmPrefix: ${summary.paths.npmPrefix ?? "(default)"}`,
    `Server active version: ${summary.serverActiveVersion ?? "(none)"}`,
    `Components: ${summary.components.join(", ") || "(none)"}`,
    ...(summary.npmPackages.length === 0
      ? ["Managed npm packages: (none)"]
      : [
          "Managed npm packages:",
          ...summary.npmPackages.map(
            (entry) =>
              `  - ${entry.packageName} version=${entry.version ?? "(unspecified)"} target=${entry.target ?? entry.version ?? "(unspecified)"}`
          )
        ])
  ].join("\n")
}

async function readRuntimeManifestObject(
  manifestPath: string
): Promise<Record<string, unknown>> {
  let parsed: unknown

  try {
    parsed = parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RuntimeManifestMutationError(
      `Failed to read manifest ${manifestPath}: ${message}`
    )
  }

  if (!isRecord(parsed)) {
    throw new RuntimeManifestMutationError(
      `Manifest ${manifestPath} must be a YAML object.`
    )
  }

  return parsed
}

async function writeRuntimeManifestObject(
  manifestPath: string,
  manifestObject: Record<string, unknown>
): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, stringify(manifestObject), "utf8")
}

function materializePackagedScriptPaths(
  manifestObject: Record<string, unknown>,
  manifestDir: string
): void {
  const components = manifestObject.components
  if (!Array.isArray(components)) {
    return
  }

  for (const component of components) {
    if (!isRecord(component)) {
      continue
    }

    for (const key of [
      "installScript",
      "verifyScript",
      "configureScript",
      "updateScript",
      "removeScript"
    ]) {
      const value = component[key]
      if (typeof value !== "string" || value.trim().length === 0) {
        continue
      }

      component[key] = resolve(manifestDir, value.trim())
    }
  }
}

function applyRuntimeManifestUpdates(
  manifestObject: Record<string, unknown>,
  options: {
    pathUpdates?: RuntimeManifestPathUpdates
    npmPackageUpdates?: readonly RuntimeManifestNpmPackageUpdate[]
    serverActiveVersion?: string
  }
): string[] {
  const changedFields: string[] = []
  const pathsObject = ensureObject(manifestObject, "paths")

  for (const [key, value] of Object.entries(options.pathUpdates ?? {})) {
    if (!value) {
      continue
    }

    pathsObject[key] = value
    changedFields.push(`paths.${key}`)
  }

  for (const update of options.npmPackageUpdates ?? []) {
    const npmSyncObject = ensureObject(manifestObject, "npmSync")
    const packagesObject = ensureObject(npmSyncObject, "packages")
    const packageObject = ensureObject(packagesObject, update.packageName)
    packageObject.version = update.version
    packageObject.target = update.target ?? update.version
    changedFields.push(`npmSync.packages.${update.packageName}`)
  }

  if (options.serverActiveVersion) {
    const serverComponent = findNamedComponent(manifestObject, "server")
    const releasedServiceObject = ensureObject(serverComponent, "releasedService")
    releasedServiceObject.activeVersion = options.serverActiveVersion
    changedFields.push("components.server.releasedService.activeVersion")
  }

  return changedFields
}

function findNamedComponent(
  manifestObject: Record<string, unknown>,
  componentName: string
): Record<string, unknown> {
  const components = manifestObject.components
  if (!Array.isArray(components)) {
    throw new RuntimeManifestMutationError("Manifest components must be an array.")
  }

  for (const component of components) {
    if (isRecord(component) && component.name === componentName) {
      return component
    }
  }

  throw new RuntimeManifestMutationError(
    `Manifest does not define a ${componentName} component.`
  )
}

function ensureObject(
  owner: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const current = owner[key]
  if (isRecord(current)) {
    return current
  }

  const next: Record<string, unknown> = {}
  owner[key] = next
  return next
}

function readManifestNpmPackages(
  npmSync: LoadedRuntimeManifest["npmSync"]
): RuntimeManifestSummary["npmPackages"] {
  const packages = npmSync?.packages
  if (!isRecord(packages)) {
    return []
  }

  return Object.entries(packages)
    .flatMap(([packageName, value]) =>
      isRecord(value)
        ? [
            {
              packageName,
              version: typeof value.version === "string" ? value.version : undefined,
              target: typeof value.target === "string" ? value.target : undefined
            }
          ]
        : []
    )
    .sort((left, right) => left.packageName.localeCompare(right.packageName))
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
