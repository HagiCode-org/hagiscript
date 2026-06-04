import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  renderManagedPm2EnvironmentText,
  renderManagedPm2StatusText,
  resolveManagedPm2Environment,
  runManagedPm2Command,
  type ManagedPm2CommandResult,
  type ManagedPm2EnvironmentResult,
  type ManagedPm2ServiceName
} from "./pm2-manager.js"
import { loadRuntimeManifest, type LoadedRuntimeManifest, type RuntimeComponentDefinition } from "./runtime-manifest.js"
import {
  getComponentLogsDirectory,
  getComponentManagedRoot,
  getComponentRuntimeDataHome,
  getVersionedRuntimeComponentRoot,
  sanitizeRuntimeComponentVersionSegment,
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"
import {
  createBundledSevenZipExtractor,
  type SevenZipExtractor
} from "./seven-zip-extract.js"

export type DedicatedComponentName = "omniroute" | "code_server"
export type DedicatedComponentAction = "exact" | "start" | "stop" | "restart" | "status" | "env" | "logs"

export interface ComponentServiceCommandOptions {
  manifestPath?: string
  runtimeRoot?: string
  lines?: number
  consumer?: string
  dependencyManagementMode?: string
  externalNodePath?: string
}

interface ComponentServiceDefinition {
  component: DedicatedComponentName
  service: ManagedPm2ServiceName
  manifestComponentName: ManagedPm2ServiceName
  directoryName: string
  displayName: string
  archiveFileName: string
  payloadEntrypointRelativePath: string
  logFileName: string
}

interface PackagedComponentMarker {
  version?: string | null
  archivePath?: string | null
  archiveFormat?: string | null
}

interface StoredExtractedRuntimeState {
  component: DedicatedComponentName
  service: ManagedPm2ServiceName
  version: string
  versionedRoot: string
  currentRoot: string
  archivePath: string
  updatedAt: string
}

interface ResolvedExtractedRuntime {
  componentDefinition: ComponentServiceDefinition
  manifest: LoadedRuntimeManifest
  manifestComponent: RuntimeComponentDefinition
  paths: ResolvedRuntimePaths
  version: string
  versionedRoot: string
  currentRoot: string
  archivePath: string
  packagedRoot: string
  runtimeDataHome: string
  logsDirectory: string
  stateFilePath: string
}

interface ComponentServiceManagerDependencies {
  loadRuntimeManifest: typeof loadRuntimeManifest
  resolveRuntimePaths: typeof resolveRuntimePaths
  runManagedPm2Command: typeof runManagedPm2Command
  resolveManagedPm2Environment: typeof resolveManagedPm2Environment
  renderManagedPm2StatusText: typeof renderManagedPm2StatusText
  renderManagedPm2EnvironmentText: typeof renderManagedPm2EnvironmentText
  createSevenZipExtractor: () => SevenZipExtractor
}

export type ComponentServiceResult =
  | ComponentLifecycleEnvelope
  | ComponentEnvironmentEnvelope
  | ComponentExactEnvelope
  | ComponentLogsEnvelope

export interface ComponentLifecycleEnvelope {
  component: DedicatedComponentName
  service: ManagedPm2ServiceName
  action: Extract<DedicatedComponentAction, "start" | "stop" | "restart" | "status">
  ok: true
  status: ManagedPm2CommandResult
}

export interface ComponentEnvironmentEnvelope {
  component: DedicatedComponentName
  service: ManagedPm2ServiceName
  action: "env"
  ok: true
  environment: ManagedPm2EnvironmentResult
}

export interface ComponentExactEnvelope {
  component: DedicatedComponentName
  service: ManagedPm2ServiceName
  action: "exact"
  ok: true
  version: string
  archivePath: string
  extractedRuntimeRoot: string
  currentRoot: string
}

export interface ComponentLogsEnvelope {
  component: DedicatedComponentName
  service: ManagedPm2ServiceName
  action: "logs"
  ok: true
  target: string
  targetPath: string
  requestedLines: number
  lines: string[]
}

const COMPONENT_DEFINITIONS: Record<DedicatedComponentName, ComponentServiceDefinition> = {
  omniroute: {
    component: "omniroute",
    service: "omniroute",
    manifestComponentName: "omniroute",
    directoryName: "omniroute",
    displayName: "OmniRoute",
    archiveFileName: "omniroute.7z",
    payloadEntrypointRelativePath: join("bin", "omniroute.mjs"),
    logFileName: "omniroute.log"
  },
  code_server: {
    component: "code_server",
    service: "code-server",
    manifestComponentName: "code-server",
    directoryName: "code_server",
    displayName: "code-server",
    archiveFileName: "code-server.7z",
    payloadEntrypointRelativePath: join("out", "node", "entry.js"),
    logFileName: "code-server.log"
  }
}

const DEFAULT_LOG_LINES = 100
export const MAX_COMPONENT_LOG_LINES = 2000

const defaultDependencies: ComponentServiceManagerDependencies = {
  loadRuntimeManifest,
  resolveRuntimePaths,
  runManagedPm2Command,
  resolveManagedPm2Environment,
  renderManagedPm2StatusText,
  renderManagedPm2EnvironmentText,
  createSevenZipExtractor: () => createBundledSevenZipExtractor()
}

export async function executeComponentServiceAction(
  component: DedicatedComponentName,
  action: DedicatedComponentAction,
  options: ComponentServiceCommandOptions = {},
  dependencies: Partial<ComponentServiceManagerDependencies> = {}
): Promise<ComponentServiceResult> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies
  }
  const definition = resolveComponentServiceDefinition(component)

  if (action === "exact") {
    return exactComponentRuntime(definition, options, resolvedDependencies)
  }

  const runtime = await resolveExtractedRuntime(definition, options, resolvedDependencies)

  switch (action) {
    case "start":
    case "stop":
    case "restart":
    case "status": {
      const status = await resolvedDependencies.runManagedPm2Command({
        manifestPath: options.manifestPath,
        runtimeRoot: options.runtimeRoot,
        service: definition.service,
        action,
        componentRootOverride: runtime.versionedRoot,
        ...(options.consumer ? { consumer: options.consumer } : {}),
        ...(options.dependencyManagementMode
          ? { dependencyManagementMode: options.dependencyManagementMode }
          : {}),
        ...(options.externalNodePath ? { externalNodePath: options.externalNodePath } : {})
      })

      return {
        component: definition.component,
        service: definition.service,
        action,
        ok: true,
        status
      }
    }
    case "env": {
      const environment = await resolvedDependencies.resolveManagedPm2Environment({
        manifestPath: options.manifestPath,
        runtimeRoot: options.runtimeRoot,
        service: definition.service,
        componentRootOverride: runtime.versionedRoot,
        ...(options.consumer ? { consumer: options.consumer } : {}),
        ...(options.dependencyManagementMode
          ? { dependencyManagementMode: options.dependencyManagementMode }
          : {}),
        ...(options.externalNodePath ? { externalNodePath: options.externalNodePath } : {})
      })

      return {
        component: definition.component,
        service: definition.service,
        action,
        ok: true,
        environment
      }
    }
    case "logs": {
      const requestedLines = options.lines ?? DEFAULT_LOG_LINES
      const targetPath = resolveAllowlistedLogTarget(runtime)
      const lines = await readRecentLines(targetPath, requestedLines)

      return {
        component: definition.component,
        service: definition.service,
        action,
        ok: true,
        target: "component",
        targetPath,
        requestedLines,
        lines
      }
    }
  }
}

export function renderComponentServiceResultText(
  result: ComponentServiceResult,
  dependencies: Partial<Pick<ComponentServiceManagerDependencies, "renderManagedPm2StatusText" | "renderManagedPm2EnvironmentText">> = {}
): string {
  const resolvedDependencies = {
    renderManagedPm2StatusText,
    renderManagedPm2EnvironmentText,
    ...dependencies
  }

  switch (result.action) {
    case "exact":
      return [
        `Component: ${result.component}`,
        `Service: ${result.service}`,
        `Action: ${result.action}`,
        `Version: ${result.version}`,
        `Archive: ${result.archivePath}`,
        `Extracted runtime: ${result.extractedRuntimeRoot}`,
        `Current root: ${result.currentRoot}`
      ].join("\n")
    case "env":
      return [
        `Component: ${result.component}`,
        resolvedDependencies.renderManagedPm2EnvironmentText(result.environment)
      ].join("\n")
    case "logs":
      return [
        `Component: ${result.component}`,
        `Service: ${result.service}`,
        `Action: ${result.action}`,
        `Target: ${result.target}`,
        `Target path: ${result.targetPath}`,
        `Requested lines: ${result.requestedLines}`,
        ...(result.lines.length > 0 ? result.lines : ["(no log lines yet)"])
      ].join("\n")
    default:
      return [
        `Component: ${result.component}`,
        resolvedDependencies.renderManagedPm2StatusText(result.status)
      ].join("\n")
  }
}

export function parseDedicatedComponentLinesOption(value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(
      `--lines must be a positive integer between 1 and ${MAX_COMPONENT_LOG_LINES}.`
    )
  }

  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_COMPONENT_LOG_LINES) {
    throw new Error(
      `--lines must be a positive integer between 1 and ${MAX_COMPONENT_LOG_LINES}.`
    )
  }

  return parsed
}

export function resolveComponentServiceDefinition(
  component: DedicatedComponentName
): ComponentServiceDefinition {
  return COMPONENT_DEFINITIONS[component]
}

async function exactComponentRuntime(
  definition: ComponentServiceDefinition,
  options: ComponentServiceCommandOptions,
  dependencies: ComponentServiceManagerDependencies
): Promise<ComponentExactEnvelope> {
  const manifest = await dependencies.loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = dependencies.resolveRuntimePaths(manifest, {
    runtimeRoot: options.runtimeRoot
  })
  const manifestComponent = manifest.componentMap.get(definition.manifestComponentName)

  if (!manifestComponent) {
    throw new Error(
      `Runtime manifest does not define the ${definition.service} component required by hagiscript ${definition.component}.`
    )
  }

  if (manifestComponent.bundledInstallMode !== "archive-7z-only") {
    throw new Error(
      `hagiscript ${definition.component} exact requires bundledInstallMode=archive-7z-only for ${definition.service}.`
    )
  }

  const packagedRoot = getComponentManagedRoot(paths, manifestComponent.name)
  const packagedMarker = await readPackagedComponentMarker(packagedRoot)
  const archivePath = resolveArchivePath(definition, packagedRoot, packagedMarker)
  await assertPathExists(
    archivePath,
    `Managed ${definition.displayName} archive is missing: ${archivePath}. Run \`hagiscript runtime install\` first.`
  )

  if (packagedMarker?.archiveFormat && packagedMarker.archiveFormat !== "7z") {
    throw new Error(
      `Managed ${definition.displayName} archive ${archivePath} is not a .7z payload. Received ${packagedMarker.archiveFormat}.`
    )
  }

  const version = resolveComponentVersion(manifestComponent, packagedMarker)
  const versionedRoot = getVersionedRuntimeComponentRoot(paths, definition.directoryName, version)
  const currentRoot = join(versionedRoot, "current")
  const runtimeDataHome = getComponentRuntimeDataHome(
    paths,
    manifestComponent.name,
    manifestComponent.runtimeDataDir
  )
  const logsDirectory = getComponentLogsDirectory(
    paths,
    manifestComponent.name,
    manifestComponent.runtimeDataDir
  )
  const stateFilePath = getExtractedRuntimeStatePath(runtimeDataHome)

  if (!(await pathExists(join(currentRoot, definition.payloadEntrypointRelativePath)))) {
    const extractor = dependencies.createSevenZipExtractor()
    const stagingRoot = await mkdtemp(join(tmpdir(), `hagiscript-${definition.component}-exact-`))

    try {
      await extractor.extract(archivePath, stagingRoot)
      const payloadRoot = await locateExtractedPayloadRoot(
        stagingRoot,
        definition.payloadEntrypointRelativePath
      )
      await rm(currentRoot, { recursive: true, force: true })
      await mkdir(versionedRoot, { recursive: true })
      await cp(payloadRoot, currentRoot, { recursive: true, force: true })
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  await assertExtractedRuntimeReady(definition, versionedRoot, currentRoot)
  await mkdir(runtimeDataHome, { recursive: true })
  await mkdir(logsDirectory, { recursive: true })
  await writeExtractedRuntimeState(stateFilePath, {
    component: definition.component,
    service: definition.service,
    version,
    versionedRoot,
    currentRoot,
    archivePath,
    updatedAt: new Date().toISOString()
  })

  return {
    component: definition.component,
    service: definition.service,
    action: "exact",
    ok: true,
    version,
    archivePath,
    extractedRuntimeRoot: versionedRoot,
    currentRoot
  }
}

async function resolveExtractedRuntime(
  definition: ComponentServiceDefinition,
  options: ComponentServiceCommandOptions,
  dependencies: ComponentServiceManagerDependencies
): Promise<ResolvedExtractedRuntime> {
  const manifest = await dependencies.loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = dependencies.resolveRuntimePaths(manifest, {
    runtimeRoot: options.runtimeRoot
  })
  const manifestComponent = manifest.componentMap.get(definition.manifestComponentName)

  if (!manifestComponent) {
    throw new Error(
      `Runtime manifest does not define the ${definition.service} component required by hagiscript ${definition.component}.`
    )
  }

  const packagedRoot = getComponentManagedRoot(paths, manifestComponent.name)
  const packagedMarker = await readPackagedComponentMarker(packagedRoot)
  const version = resolveComponentVersion(manifestComponent, packagedMarker)
  const runtimeDataHome = getComponentRuntimeDataHome(
    paths,
    manifestComponent.name,
    manifestComponent.runtimeDataDir
  )
  const logsDirectory = getComponentLogsDirectory(
    paths,
    manifestComponent.name,
    manifestComponent.runtimeDataDir
  )
  const stateFilePath = getExtractedRuntimeStatePath(runtimeDataHome)
  const storedState = await readExtractedRuntimeState(stateFilePath)
  const versionedRoot =
    storedState?.version === version
      ? storedState.versionedRoot
      : getVersionedRuntimeComponentRoot(paths, definition.directoryName, version)
  const currentRoot =
    storedState?.version === version ? storedState.currentRoot : join(versionedRoot, "current")
  const archivePath = storedState?.archivePath || resolveArchivePath(definition, packagedRoot, packagedMarker)

  await assertExtractedRuntimeReady(definition, versionedRoot, currentRoot)

  return {
    componentDefinition: definition,
    manifest,
    manifestComponent,
    paths,
    version,
    versionedRoot,
    currentRoot,
    archivePath,
    packagedRoot,
    runtimeDataHome,
    logsDirectory,
    stateFilePath
  }
}

async function locateExtractedPayloadRoot(
  extractRoot: string,
  payloadEntrypointRelativePath: string
): Promise<string> {
  if (await pathExists(join(extractRoot, payloadEntrypointRelativePath))) {
    return extractRoot
  }

  const queue = [extractRoot]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const candidate = join(current, entry.name)
      if (await pathExists(join(candidate, payloadEntrypointRelativePath))) {
        return candidate
      }
      queue.push(candidate)
    }
  }

  throw new Error(
    `Extracted runtime payload does not contain ${payloadEntrypointRelativePath} under ${extractRoot}.`
  )
}

function resolveArchivePath(
  definition: ComponentServiceDefinition,
  packagedRoot: string,
  marker: PackagedComponentMarker | null
): string {
  if (marker?.archivePath?.trim()) {
    return resolve(marker.archivePath)
  }

  return join(packagedRoot, "archives", definition.archiveFileName)
}

function resolveComponentVersion(
  component: RuntimeComponentDefinition,
  marker: PackagedComponentMarker | null
): string {
  const rawVersion =
    marker?.version?.trim() || component.version?.trim() || component.channelVersion?.trim()
  if (!rawVersion) {
    throw new Error(
      `Managed runtime component ${component.name} does not expose a concrete version for extracted-runtime activation.`
    )
  }

  return sanitizeRuntimeComponentVersionSegment(rawVersion)
}

function resolveAllowlistedLogTarget(runtime: ResolvedExtractedRuntime): string {
  return join(runtime.logsDirectory, runtime.componentDefinition.logFileName)
}

async function readRecentLines(filePath: string, lines: number): Promise<string[]> {
  try {
    const contents = await readFile(filePath, "utf8")
    return contents
      .split(/\r?\n/u)
      .filter((line, index, all) => !(index === all.length - 1 && line === ""))
      .slice(-lines)
  } catch (error) {
    if (isMissingPathError(error)) {
      return []
    }

    throw error
  }
}

async function readPackagedComponentMarker(
  packagedRoot: string
): Promise<PackagedComponentMarker | null> {
  const markerPath = join(packagedRoot, ".hagicode-runtime.json")
  try {
    return JSON.parse(await readFile(markerPath, "utf8")) as PackagedComponentMarker
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }

    throw new Error(
      `Failed to read packaged runtime marker ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined
    )
  }
}

async function readExtractedRuntimeState(
  stateFilePath: string
): Promise<StoredExtractedRuntimeState | null> {
  try {
    return JSON.parse(await readFile(stateFilePath, "utf8")) as StoredExtractedRuntimeState
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }

    throw new Error(
      `Failed to read extracted runtime state ${stateFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined
    )
  }
}

async function writeExtractedRuntimeState(
  stateFilePath: string,
  state: StoredExtractedRuntimeState
): Promise<void> {
  await writeFile(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

function getExtractedRuntimeStatePath(runtimeDataHome: string): string {
  return join(runtimeDataHome, "extracted-runtime.json")
}

async function assertExtractedRuntimeReady(
  definition: ComponentServiceDefinition,
  versionedRoot: string,
  currentRoot: string
): Promise<void> {
  await assertPathExists(
    versionedRoot,
    `Managed ${definition.displayName} extracted runtime is missing: ${versionedRoot}. Run \`hagiscript ${definition.component} exact\` first.`
  )
  await assertPathExists(
    currentRoot,
    `Managed ${definition.displayName} extracted runtime root is missing: ${currentRoot}. Run \`hagiscript ${definition.component} exact\` first.`
  )
  await assertPathExists(
    join(currentRoot, definition.payloadEntrypointRelativePath),
    `Managed ${definition.displayName} extracted runtime is invalid: ${join(currentRoot, definition.payloadEntrypointRelativePath)} is missing. Re-run \`hagiscript ${definition.component} exact\`.`
  )
}

async function assertPathExists(pathValue: string, message: string): Promise<void> {
  try {
    await access(pathValue)
  } catch (error) {
    throw new Error(message, error instanceof Error ? { cause: error } : undefined)
  }
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }

    throw error
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT"
  )
}
