import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { tmpdir } from "node:os"
import {
  installNodeRuntime,
  resolveManagedNodeRuntime
} from "./node-installer.js"
import { verifyNodeRuntime } from "./node-verify.js"
import { syncNpmGlobals, type NpmSyncLogEvent } from "./npm-sync.js"
import {
  executeRuntimeScript,
  writeRuntimeLog
} from "./runtime-executor.js"
import {
  loadRuntimeManifest,
  type LoadedRuntimeManifest,
  type RuntimeComponentDefinition,
  type RuntimeLifecyclePhase
} from "./runtime-manifest.js"
import {
  getComponentConfigDirectory,
  getComponentManagedRoot,
  isPathInsideRuntimeRoot,
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"
import {
  mergeRuntimeState,
  readRuntimeState,
  writeRuntimeState,
  type RuntimeComponentState,
  type RuntimeComponentStatus,
  type RuntimeOperationState,
  type RuntimeState
} from "./runtime-state.js"

export interface RuntimeLifecycleOptions {
  manifestPath?: string
  runtimeRoot?: string
  components?: readonly string[]
  dryRun?: boolean
  force?: boolean
  purge?: boolean
  checkOnly?: boolean
  verbose?: boolean
  logger?: (message: string) => void
  now?: () => Date
}

export interface RuntimePlannedAction {
  componentName: string
  phase: RuntimeLifecyclePhase
  strategy: "builtin" | "script" | "fallback-install" | "fallback-cleanup"
  scriptPath?: string
  reason?: string
}

export interface RuntimeLifecycleResult {
  manifest: LoadedRuntimeManifest
  paths: ResolvedRuntimePaths
  state: RuntimeState
  plan: RuntimePlannedAction[]
  skipped: {
    componentName: string
    reason: string
  }[]
  changedComponents: string[]
  logFilePath?: string
}

export interface RuntimeStateReport {
  runtime: {
    name: string
    version: string
    manifestPath: string
  }
  managedRoot: string
  managedPaths: ResolvedRuntimePaths
  ready: boolean
  components: Array<{
    name: string
    type: string
    status: RuntimeComponentStatus
    version: string | null
    managedPaths: string[]
  }>
  lastOperation: RuntimeState["lastOperation"]
}

export class RuntimeLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RuntimeLifecycleError"
  }
}

export async function installRuntime(
  options: RuntimeLifecycleOptions = {}
): Promise<RuntimeLifecycleResult> {
  return runRuntimeLifecycle("install", options)
}

export async function removeRuntime(
  options: RuntimeLifecycleOptions = {}
): Promise<RuntimeLifecycleResult> {
  return runRuntimeLifecycle("remove", options)
}

export async function updateRuntime(
  options: RuntimeLifecycleOptions = {}
): Promise<RuntimeLifecycleResult> {
  return runRuntimeLifecycle("update", options)
}

export async function runRuntimeLifecycle(
  phase: RuntimeLifecyclePhase,
  options: RuntimeLifecycleOptions = {}
): Promise<RuntimeLifecycleResult> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const existingState = await readRuntimeState(paths.stateFile)
  const state = mergeRuntimeState(manifest, paths, existingState)
  const { plan, skipped } = planRuntimeLifecycle(phase, manifest, state, options)
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? (() => undefined)

  if (options.dryRun || (phase === "update" && options.checkOnly)) {
    for (const action of plan) {
      logger(
        `Plan: ${phase} ${action.componentName} (${action.strategy}${action.reason ? `: ${action.reason}` : ""})`
      )
    }

    for (const item of skipped) {
      logger(`Skip: ${item.componentName} (${item.reason})`)
    }

    return {
      manifest,
      paths,
      state,
      plan,
      skipped,
      changedComponents: []
    }
  }

  await ensureManagedDirectories(paths)
  const logFilePath = join(
    paths.logs,
    `${phase}-${now().toISOString().replaceAll(":", "-")}.log`
  )
  const operationState: RuntimeOperationState = {
    phase,
    status: "success",
    selectedComponents: plan.map((item) => item.componentName),
    completedComponents: [],
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    logFile: logFilePath
  }
  const changedComponents: string[] = []

  await writeRuntimeLog(
    logFilePath,
    `Runtime ${phase} starting with managed root ${paths.root}`
  )

  try {
    for (const action of plan) {
      const component = manifest.componentMap.get(action.componentName)
      if (!component) {
        throw new RuntimeLifecycleError(`Unknown runtime component ${action.componentName}`)
      }

      logger(`Running ${phase}: ${component.name}`)
      try {
        const componentState = await executeRuntimeAction(
          action,
          component,
          manifest,
          paths,
          options,
          logFilePath
        )

        state.components[component.name] = componentState
        changedComponents.push(component.name)
        operationState.completedComponents.push(component.name)
      } catch (error) {
        state.components[component.name] = {
          name: component.name,
          type: component.type,
          status: "failed",
          version: state.components[component.name]?.version ?? null,
          managedPaths: [getComponentManagedRoot(paths, component.name)],
          lastAction: phase,
          lastUpdatedAt: now().toISOString(),
          logFile: logFilePath,
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        }

        throw new RuntimeLifecycleError(
          `${phase} failed for component ${component.name}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? { cause: error } : undefined
        )
      }
    }

    operationState.finishedAt = now().toISOString()
    state.lastOperation = operationState
    await writeRuntimeState(paths.stateFile, state)
    return {
      manifest,
      paths,
      state,
      plan,
      skipped,
      changedComponents,
      logFilePath
    }
  } catch (error) {
    operationState.status = "failed"
    operationState.finishedAt = now().toISOString()
    operationState.message = error instanceof Error ? error.message : String(error)
    state.lastOperation = operationState
    await writeRuntimeLog(logFilePath, `Failure: ${operationState.message}`)
    await writeRuntimeState(paths.stateFile, state)
    throw error
  }
}

export async function queryRuntimeState(
  options: Pick<RuntimeLifecycleOptions, "manifestPath" | "runtimeRoot">
): Promise<RuntimeStateReport> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const state = mergeRuntimeState(
    manifest,
    paths,
    await readRuntimeState(paths.stateFile)
  )
  const components = manifest.components.map((component) => {
    const entry = state.components[component.name]
    return {
      name: component.name,
      type: component.type,
      status: entry?.status ?? "not-installed",
      version: entry?.version ?? null,
      managedPaths: entry?.managedPaths ?? [getComponentManagedRoot(paths, component.name)]
    }
  })

  return {
    runtime: state.runtime,
    managedRoot: state.managedRoot,
    managedPaths: state.managedPaths,
    ready: components.every((component) => component.status === "installed"),
    components,
    lastOperation: state.lastOperation
  }
}

export function renderRuntimeStateText(report: RuntimeStateReport): string {
  const lines = [
    `Runtime: ${report.runtime.name} ${report.runtime.version}`,
    `Manifest: ${report.runtime.manifestPath}`,
    `Managed root: ${report.managedRoot}`,
    `Bin: ${report.managedPaths.bin}`,
    `State file: ${report.managedPaths.stateFile}`,
    `Ready: ${report.ready ? "yes" : "no"}`
  ]

  for (const component of report.components) {
    lines.push(
      `- ${component.name}: ${component.status} version=${component.version ?? "n/a"} root=${component.managedPaths[0] ?? "n/a"}`
    )
  }

  if (report.lastOperation) {
    lines.push(
      `Last operation: ${report.lastOperation.phase} ${report.lastOperation.status} (${report.lastOperation.completedComponents.length}/${report.lastOperation.selectedComponents.length})`
    )
  }

  return lines.join("\n")
}

export function planRuntimeLifecycle(
  phase: RuntimeLifecyclePhase,
  manifest: LoadedRuntimeManifest,
  state: RuntimeState,
  options: RuntimeLifecycleOptions = {}
): {
  plan: RuntimePlannedAction[]
  skipped: {
    componentName: string
    reason: string
  }[]
} {
  const requestedSet = selectRequestedComponents(manifest, options.components)
  const orderedComponentNames = orderedPhaseComponents(manifest, phase).filter((name) =>
    requestedSet.has(name)
  )
  const plan: RuntimePlannedAction[] = []
  const skipped: {
    componentName: string
    reason: string
  }[] = []

  for (const componentName of orderedComponentNames) {
    const component = manifest.componentMap.get(componentName)
    if (!component) {
      throw new RuntimeLifecycleError(`Unknown runtime component ${componentName}`)
    }

    if (phase === "update" && !options.force) {
      const currentState = state.components[component.name]
      if (currentState?.status === "installed" && !componentNeedsUpdate(component, currentState)) {
        skipped.push({
          componentName: component.name,
          reason: "already up to date"
        })
        continue
      }
    }

    plan.push(resolveRuntimeAction(component, phase))
  }

  return { plan, skipped }
}

async function executeRuntimeAction(
  action: RuntimePlannedAction,
  component: RuntimeComponentDefinition,
  manifest: LoadedRuntimeManifest,
  paths: ResolvedRuntimePaths,
  options: RuntimeLifecycleOptions,
  logFilePath: string
): Promise<RuntimeComponentState> {
  const componentRoot = getComponentManagedRoot(paths, component.name)
  const componentConfigDir = getComponentConfigDirectory(paths, component.name)

  switch (component.name) {
    case "node":
      return executeNodeComponent(action.phase, component, paths, logFilePath)
    case "npm-packages":
      return executeNpmPackagesComponent(
        action.phase,
        component,
        manifest,
        paths,
        options,
        logFilePath
      )
    default:
      return executeScriptComponent(
        action,
        component,
        manifest,
        paths,
        componentRoot,
        componentConfigDir,
        options,
        logFilePath
      )
  }
}

async function executeNodeComponent(
  phase: RuntimeLifecyclePhase,
  component: RuntimeComponentDefinition,
  paths: ResolvedRuntimePaths,
  logFilePath: string
): Promise<RuntimeComponentState> {
  if (phase === "remove") {
    await rm(paths.nodeRuntime, { recursive: true, force: true })
    await removeWrapper(paths.bin, "node")
    await removeWrapper(paths.bin, "npm")
    await writeRuntimeLog(logFilePath, "Removed managed node runtime directories")
    return {
      name: component.name,
      type: component.type,
      status: "removed",
      version: null,
      managedPaths: [paths.nodeRuntime],
      lastAction: phase,
      lastUpdatedAt: new Date().toISOString(),
      logFile: logFilePath
    }
  }

  const desiredVersion = component.version ?? component.channelVersion
  const currentVerification = await verifyNodeRuntime(paths.nodeRuntime)
  const normalizedCurrentVersion = normalizeVersion(currentVerification.nodeVersion)
  const normalizedDesiredVersion = normalizeVersion(desiredVersion)

  if (!currentVerification.valid) {
    await rm(paths.nodeRuntime, { recursive: true, force: true })
  }

  if (
    phase === "update" &&
    currentVerification.valid &&
    normalizedDesiredVersion &&
    normalizedCurrentVersion &&
    normalizedDesiredVersion !== normalizedCurrentVersion
  ) {
    await rm(paths.nodeRuntime, { recursive: true, force: true })
  }

  const resolvedRuntime = await resolveNodeRuntimeForPhase(
    phase,
    paths.nodeRuntime,
    desiredVersion,
    currentVerification
  )

  const wrappers = await materializeNodeWrappers(paths.bin, {
    nodePath: resolvedRuntime.nodePath,
    npmPath: resolvedRuntime.npmPath
  })
  await writeRuntimeLog(
    logFilePath,
    `Node runtime ready: ${resolvedRuntime.targetDirectory} (${resolvedRuntime.nodeVersion})`
  )
  return {
    name: component.name,
    type: component.type,
    status: "installed",
    version: normalizeVersion(resolvedRuntime.nodeVersion),
    managedPaths: [paths.nodeRuntime, ...wrappers],
    lastAction: phase,
    lastUpdatedAt: new Date().toISOString(),
    logFile: logFilePath
  }
}

async function executeNpmPackagesComponent(
  phase: RuntimeLifecyclePhase,
  component: RuntimeComponentDefinition,
  manifest: LoadedRuntimeManifest,
  paths: ResolvedRuntimePaths,
  options: RuntimeLifecycleOptions,
  logFilePath: string
): Promise<RuntimeComponentState> {
  if (phase === "remove") {
    await rm(paths.npmPrefix, { recursive: true, force: true })
    await writeRuntimeLog(logFilePath, `Removed managed npm prefix ${paths.npmPrefix}`)
    return {
      name: component.name,
      type: component.type,
      status: "removed",
      version: null,
      managedPaths: [paths.npmPrefix],
      lastAction: phase,
      lastUpdatedAt: new Date().toISOString(),
      logFile: logFilePath
    }
  }

  await resolveManagedNodeRuntime({
    targetDirectory: paths.nodeRuntime,
    versionSelector: manifest.componentMap.get("node")?.version ?? "22"
  })

  const scratchDirectory = await mkdtemp(join(tmpdir(), "hagiscript-runtime-npm-"))
  const manifestPath = join(scratchDirectory, "npm-sync-manifest.json")
  const npmManifest = {
    packages: Object.fromEntries(
      component.packageCatalog.map((entry) => [
        entry.packageName,
        toNpmSyncManifestEntry(entry.packageName, entry.installSpec)
      ])
    )
  }

  try {
    await writeFile(manifestPath, `${JSON.stringify(npmManifest, null, 2)}\n`, "utf8")
    const summary = await syncNpmGlobals({
      runtimePath: paths.nodeRuntime,
      manifestPath,
      force: options.force,
      npmOptions: {
        prefix: paths.npmPrefix
      },
      onLog: (event) => appendNpmSyncLog(logFilePath, event)
    })
    await writeRuntimeLog(
      logFilePath,
      `Managed npm prefix ready: ${paths.npmPrefix} changed=${summary.changedCount}`
    )
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true })
  }

  return {
    name: component.name,
    type: component.type,
    status: "installed",
    version: computePackageCatalogFingerprint(component),
    managedPaths: [paths.npmPrefix],
    lastAction: phase,
    lastUpdatedAt: new Date().toISOString(),
    logFile: logFilePath,
    details: {
      packageCount: component.packageCatalog.length
    }
  }
}

async function executeScriptComponent(
  action: RuntimePlannedAction,
  component: RuntimeComponentDefinition,
  manifest: LoadedRuntimeManifest,
  paths: ResolvedRuntimePaths,
  componentRoot: string,
  componentConfigDir: string,
  options: RuntimeLifecycleOptions,
  logFilePath: string
): Promise<RuntimeComponentState> {
  await mkdir(componentRoot, { recursive: true })
  await mkdir(componentConfigDir, { recursive: true })
  const scriptPath = resolveScriptForAction(action, component)

  if (scriptPath) {
    await executeRuntimeScript(scriptPath, {
      component,
      phase: action.phase,
      manifest,
      paths,
      componentRoot,
      componentConfigDir,
      logFilePath,
      purge: options.purge,
      verbose: options.verbose
    })

    if (action.phase !== "remove" && component.scripts.configure) {
      await executeRuntimeScript(component.scripts.configure, {
        component,
        phase: action.phase,
        manifest,
        paths,
        componentRoot,
        componentConfigDir,
        logFilePath,
        purge: options.purge,
        verbose: options.verbose
      })
    }

    if (action.phase !== "remove" && component.scripts.verify) {
      await executeRuntimeScript(component.scripts.verify, {
        component,
        phase: action.phase,
        manifest,
        paths,
        componentRoot,
        componentConfigDir,
        logFilePath,
        purge: options.purge,
        verbose: options.verbose
      })
    }
  } else {
    await cleanupManagedComponent(
      paths.root,
      componentRoot,
      ...(options.purge ? [componentConfigDir] : [])
    )
  }

  const isRemoval = action.phase === "remove"
  return {
    name: component.name,
    type: component.type,
    status: isRemoval ? "removed" : "installed",
    version: isRemoval ? null : component.version ?? component.channelVersion ?? null,
    managedPaths:
      isRemoval && !options.purge
        ? [componentRoot]
        : isRemoval
          ? [componentRoot, componentConfigDir]
          : [componentRoot, componentConfigDir],
    lastAction: action.phase,
    lastUpdatedAt: new Date().toISOString(),
    logFile: logFilePath
  }
}

function selectRequestedComponents(
  manifest: LoadedRuntimeManifest,
  requestedComponents: readonly string[] | undefined
): Set<string> {
  if (!requestedComponents || requestedComponents.length === 0) {
    return new Set(manifest.components.map((component) => component.name))
  }

  const requestedSet = new Set<string>()

  for (const value of requestedComponents) {
    if (!manifest.componentMap.has(value)) {
      throw new RuntimeLifecycleError(`Unknown runtime component: ${value}`)
    }

    requestedSet.add(value)
  }

  return requestedSet
}

function orderedPhaseComponents(
  manifest: LoadedRuntimeManifest,
  phase: RuntimeLifecyclePhase
): string[] {
  const definition = manifest.phases[phase]
  const ordered = [...definition.order]
  return definition.reverse ? ordered.reverse() : ordered
}

function resolveRuntimeAction(
  component: RuntimeComponentDefinition,
  phase: RuntimeLifecyclePhase
): RuntimePlannedAction {
  if (component.name === "node" || component.name === "npm-packages") {
    return {
      componentName: component.name,
      phase,
      strategy: "builtin"
    }
  }

  if (phase === "install") {
    return {
      componentName: component.name,
      phase,
      strategy: "script",
      scriptPath: component.scripts.install
    }
  }

  if (phase === "update") {
    if (component.scripts.update) {
      return {
        componentName: component.name,
        phase,
        strategy: "script",
        scriptPath: component.scripts.update
      }
    }

    return {
      componentName: component.name,
      phase,
      strategy: "fallback-install",
      scriptPath: component.scripts.install,
      reason: "update hook missing; reusing install hook"
    }
  }

  if (component.scripts.remove) {
    return {
      componentName: component.name,
      phase,
      strategy: "script",
      scriptPath: component.scripts.remove
    }
  }

  return {
    componentName: component.name,
    phase,
    strategy: "fallback-cleanup",
    reason: "remove hook missing; cleaning managed paths only"
  }
}

function componentNeedsUpdate(
  component: RuntimeComponentDefinition,
  state: RuntimeComponentState
): boolean {
  if (state.status !== "installed") {
    return true
  }

  if (component.name === "npm-packages") {
    return state.version !== computePackageCatalogFingerprint(component)
  }

  const desiredVersion = component.version ?? component.channelVersion ?? null
  return desiredVersion !== state.version
}

function resolveScriptForAction(
  action: RuntimePlannedAction,
  component: RuntimeComponentDefinition
): string | null {
  switch (action.strategy) {
    case "script":
    case "fallback-install":
      return action.scriptPath ?? component.scripts.install
    case "builtin":
    case "fallback-cleanup":
      return null
  }
}

function toNpmSyncManifestEntry(packageName: string, installSpec: string): {
  version: string
  target?: string
} {
  const trimmed = installSpec.trim()
  const scopedPrefix = `${packageName}@`

  if (trimmed === packageName) {
    return {
      version: "*"
    }
  }

  if (trimmed.startsWith(scopedPrefix)) {
    const selector = trimmed.slice(scopedPrefix.length).trim()
    return {
      version: selector || "*",
      target: selector || undefined
    }
  }

  return {
    version: "*",
    target: trimmed
  }
}

function computePackageCatalogFingerprint(component: RuntimeComponentDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(component.packageCatalog))
    .digest("hex")
    .slice(0, 12)
}

async function ensureManagedDirectories(paths: ResolvedRuntimePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.bin, { recursive: true }),
    mkdir(paths.config, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.componentsRoot, { recursive: true }),
    mkdir(paths.vendoredRoot, { recursive: true })
  ])
}

async function appendNpmSyncLog(
  logFilePath: string,
  event: NpmSyncLogEvent
): Promise<void> {
  await writeRuntimeLog(logFilePath, `npm-sync:${event.type} ${JSON.stringify(event)}`)
}

async function cleanupManagedComponent(
  runtimeRoot: string,
  ...paths: string[]
): Promise<void> {
  for (const pathValue of paths) {
    if (!isPathInsideRuntimeRoot(runtimeRoot, pathValue)) {
      throw new RuntimeLifecycleError(
        `Refusing to clean path outside managed runtime root: ${pathValue}`
      )
    }

    await rm(pathValue, { recursive: true, force: true })
  }
}

async function materializeNodeWrappers(
  binDirectory: string,
  executables: {
    nodePath: string
    npmPath: string
  }
): Promise<string[]> {
  await mkdir(binDirectory, { recursive: true })
  return Promise.all([
    writeExecutableWrapper(binDirectory, "node", executables.nodePath),
    writeExecutableWrapper(binDirectory, "npm", executables.npmPath)
  ])
}

async function writeExecutableWrapper(
  binDirectory: string,
  commandName: string,
  targetPath: string
): Promise<string> {
  const wrapperPath =
    process.platform === "win32"
      ? join(binDirectory, `${commandName}.cmd`)
      : join(binDirectory, commandName)
  const relativeTarget = relative(binDirectory, targetPath)

  await writeFile(
    wrapperPath,
    process.platform === "win32"
      ? `@echo off\r\n"%~dp0\\${relativeTarget.replaceAll("/", "\\")}" %*\r\n`
      : `#!/usr/bin/env sh\nexec "$(dirname "$0")/${relativeTarget.replaceAll("\\", "/")}" "$@"\n`,
    "utf8"
  )

  return wrapperPath
}

async function removeWrapper(binDirectory: string, commandName: string): Promise<void> {
  const wrapperPath =
    process.platform === "win32"
      ? join(binDirectory, `${commandName}.cmd`)
      : join(binDirectory, commandName)
  await rm(wrapperPath, { force: true })
}

function normalizeVersion(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  return value.replace(/^v/u, "")
}

async function resolveNodeRuntimeForPhase(
  phase: RuntimeLifecyclePhase,
  targetDirectory: string,
  desiredVersion: string | undefined,
  currentVerification: Awaited<ReturnType<typeof verifyNodeRuntime>>
): Promise<{
  targetDirectory: string
  nodePath: string
  npmPath: string
  nodeVersion: string
  npmVersion: string
}> {
  if (
    phase === "update" &&
    currentVerification.valid &&
    normalizeVersion(currentVerification.nodeVersion) === normalizeVersion(desiredVersion)
  ) {
    return {
      targetDirectory: currentVerification.targetDirectory,
      nodePath: currentVerification.nodePath ?? "",
      npmPath: currentVerification.npmPath ?? "",
      nodeVersion: currentVerification.nodeVersion ?? "",
      npmVersion: currentVerification.npmVersion ?? ""
    }
  }

  if (phase === "update") {
    const installed = await installNodeRuntime({
      targetDirectory,
      versionSelector: desiredVersion
    })
    return {
      targetDirectory: installed.targetDirectory,
      nodePath: installed.nodePath,
      npmPath: installed.npmPath,
      nodeVersion: installed.version,
      npmVersion: installed.npmVersion
    }
  }

  return resolveManagedNodeRuntime({
    targetDirectory,
    versionSelector: desiredVersion
  })
}
