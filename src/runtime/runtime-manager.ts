import { existsSync } from "node:fs"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import process from "node:process"
import semver from "semver"
import {
  installGlobalPackage,
  listGlobalPackages,
  type NpmGlobalCommandOptions
} from "./npm-global.js"
import { validateNpmSyncManifest } from "./npm-sync.js"
import {
  installNodeRuntime,
  resolveManagedNodeRuntime
} from "./node-installer.js"
import { getRuntimeExecutablePaths, verifyNodeRuntime } from "./node-verify.js"
import {
  executeRuntimeScript,
  writeRuntimeLog
} from "./runtime-executor.js"
import {
  ManagedPm2Error,
  runManagedPm2Command,
  supportedPm2Services,
  type ManagedPm2ServiceName
} from "./pm2-manager.js"
import {
  loadRuntimeManifest,
  type LoadedRuntimeManifest,
  type RuntimeComponentDefinition,
  type RuntimeLifecyclePhase
} from "./runtime-manifest.js"
import {
  getComponentConfigDirectory,
  getComponentLogsDirectory,
  getComponentManagedRoot,
  getComponentPm2Home,
  getComponentRuntimeDataHome,
  isPathInsideRuntimeRoot,
  resolveReleasedServicePath,
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
  downloadCache?: boolean
  downloadCacheDir?: string
  npmRegistryMirror?: string
  pm2VersionOverride?: string
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
  layout: {
    separated: boolean
    runtimeHome: string
    runtimeDataRoot: string
    programRoots: string[]
    externalDataRoots: string[]
  }
  ready: boolean
  components: Array<{
    name: string
    type: string
    status: RuntimeComponentStatus
    version: string | null
    runtimeDataHome: string | null
    pm2Home: string | null
    programPaths: string[]
    externalDataPaths: string[]
    managedPaths: string[]
    details?: Record<string, unknown>
  }>
  lastOperation: RuntimeState["lastOperation"]
}

export class RuntimeLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RuntimeLifecycleError"
  }
}

const DEFAULT_MANAGED_PM2_VERSION = "7.0.1"

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
          managedProgramPaths: [getComponentManagedRoot(paths, component.name)],
          managedDataPaths: [
            getComponentRuntimeDataHome(paths, component.name, component.runtimeDataDir),
            getComponentConfigDirectory(paths, component.name, component.runtimeDataDir),
            getComponentLogsDirectory(paths, component.name, component.runtimeDataDir),
            ...(component.pm2
              ? [
                  getComponentPm2Home(
                    paths,
                    component.name,
                    component.runtimeDataDir,
                    component.pm2.pm2Home
                  )
                ]
              : [])
          ],
          managedPaths: [
            getComponentManagedRoot(paths, component.name),
            getComponentRuntimeDataHome(paths, component.name, component.runtimeDataDir),
            getComponentConfigDirectory(paths, component.name, component.runtimeDataDir),
            getComponentLogsDirectory(paths, component.name, component.runtimeDataDir),
            ...(component.pm2
              ? [
                  getComponentPm2Home(
                    paths,
                    component.name,
                    component.runtimeDataDir,
                    component.pm2.pm2Home
                  )
                ]
              : [])
          ],
          lastAction: phase,
          lastUpdatedAt: now().toISOString(),
          logFile: logFilePath,
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        }

        throw new RuntimeLifecycleError(
          `${phase} failed for component ${component.name}: ${error instanceof Error ? error.message : String(error)}\nLog: ${logFilePath}`,
          error instanceof Error ? { cause: error } : undefined
        )
      }
    }

    if (phase !== "remove" && shouldEnsureManagedPm2(plan, manifest)) {
      const pm2Result = await ensureManagedPm2Package(manifest, paths, options)
      await writeRuntimeLog(
        logFilePath,
        pm2Result.changed
          ? `Managed pm2 installed into ${pm2Result.prefix} using ${pm2Result.selector}`
          : `Managed pm2 already satisfied in ${pm2Result.prefix} (${pm2Result.installedVersion ?? "unknown version"})`
      )
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
    const fallbackProgramPaths = [getComponentManagedRoot(paths, component.name)]
    const runtimeDataHome = getComponentRuntimeDataHome(
      paths,
      component.name,
      component.runtimeDataDir
    )
    const pm2Home = component.pm2
      ? getComponentPm2Home(
          paths,
          component.name,
          component.runtimeDataDir,
          component.pm2.pm2Home
        )
      : null
    const fallbackDataPaths = [
      runtimeDataHome,
      getComponentConfigDirectory(paths, component.name, component.runtimeDataDir),
      getComponentLogsDirectory(paths, component.name, component.runtimeDataDir),
      ...(pm2Home ? [pm2Home] : [])
    ]
    const programPaths = entry?.managedProgramPaths ?? fallbackProgramPaths
    const externalDataPaths = entry?.managedDataPaths ?? fallbackDataPaths
    return {
      name: component.name,
      type: component.type,
      status: entry?.status ?? "not-installed",
      version: entry?.version ?? null,
      runtimeDataHome,
      pm2Home,
      programPaths,
      externalDataPaths,
      managedPaths: entry?.managedPaths ?? [...programPaths, ...externalDataPaths],
      details: entry?.details
    }
  })
  const programRoots = [
    paths.runtimeHome,
    paths.bin,
    paths.componentsRoot
  ]
  const externalDataRoots = [
    paths.runtimeDataRoot,
    paths.config,
    paths.logs,
    paths.data,
    paths.componentDataRoot,
    paths.npmPrefix
  ]

  return {
    runtime: state.runtime,
    managedRoot: state.managedRoot,
    managedPaths: state.managedPaths,
    layout: {
      separated: paths.runtimeHome !== paths.runtimeDataRoot,
      runtimeHome: paths.runtimeHome,
      runtimeDataRoot: paths.runtimeDataRoot,
      programRoots,
      externalDataRoots
    },
    ready: components.every(
      (component) =>
        component.status === "installed" &&
        (component.details?.releasedServiceReady as boolean | undefined) !== false
    ),
    components,
    lastOperation: state.lastOperation
  }
}

export function renderRuntimeStateText(report: RuntimeStateReport): string {
  const lines = [
    `Runtime: ${report.runtime.name} ${report.runtime.version}`,
    `Manifest: ${report.runtime.manifestPath}`,
    `Managed root: ${report.managedRoot}`,
    `Runtime home: ${report.layout.runtimeHome}`,
    `Runtime data root: ${report.layout.runtimeDataRoot}`,
    `Bin: ${report.managedPaths.bin}`,
    `State file: ${report.managedPaths.stateFile}`,
    `Program roots: ${report.layout.programRoots.join(", ")}`,
    `External data roots: ${report.layout.externalDataRoots.join(", ")}`,
    `Separated layout: ${report.layout.separated ? "yes" : "no"}`,
    `Ready: ${report.ready ? "yes" : "no"}`
  ]

  for (const component of report.components) {
    lines.push(
      `- ${component.name}: ${component.status} version=${component.version ?? "n/a"} program=${component.programPaths.join("|") || "n/a"} data=${component.externalDataPaths.join("|") || "n/a"}`
    )
    if (component.runtimeDataHome) {
      lines.push(`  runtime-data-home=${component.runtimeDataHome}`)
    }
    if (component.pm2Home) {
      lines.push(`  pm2-home=${component.pm2Home}`)
    }
    const details = stateDetailsFromComponent(component)
    if (details) {
      lines.push(`  details=${details}`)
    }
  }

  if (report.lastOperation) {
    lines.push(
      `Last operation: ${report.lastOperation.phase} ${report.lastOperation.status} (${report.lastOperation.completedComponents.length}/${report.lastOperation.selectedComponents.length})`
    )
  }

  return lines.join("\n")
}

function stateDetailsFromComponent(component: RuntimeStateReport["components"][number]): string | null {
  const details = (component as typeof component & { details?: Record<string, unknown> }).details
  if (!details) {
    return null
  }

  const summary =
    typeof details.readinessSummary === "string"
      ? details.readinessSummary
      : typeof details.cleanupSummary === "string"
        ? details.cleanupSummary
        : null

  return summary
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
  const requestedSet = selectRequestedComponents(manifest, options.components, phase)
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
  const componentConfigDir = getComponentConfigDirectory(
    paths,
    component.name,
    component.runtimeDataDir
  )

  switch (component.name) {
    case "node":
      return executeNodeComponent(action.phase, component, paths, options, logFilePath)
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
  options: RuntimeLifecycleOptions,
  logFilePath: string
): Promise<RuntimeComponentState> {
  await mkdir(dirname(paths.nodeRuntime), { recursive: true })

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
      managedProgramPaths: [paths.nodeRuntime],
      managedDataPaths: [],
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
    currentVerification,
    options.downloadCache,
    options.downloadCacheDir
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
    managedProgramPaths: [paths.nodeRuntime, ...wrappers],
    managedDataPaths: [],
    managedPaths: [paths.nodeRuntime, ...wrappers],
    lastAction: phase,
    lastUpdatedAt: new Date().toISOString(),
    logFile: logFilePath
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
    if (action.phase === "remove") {
      await cleanupManagedPm2Service(component, manifest, paths, options, logFilePath)
    }

    await executeRuntimeScript(scriptPath, {
      component,
      phase: action.phase,
      manifest,
      paths,
      componentRoot,
      componentConfigDir,
      logFilePath,
      purge: options.purge,
      verbose: options.verbose,
      downloadCache: options.downloadCache,
      downloadCacheDir: options.downloadCacheDir,
      npmRegistryMirror: options.npmRegistryMirror,
      pm2VersionOverride: options.pm2VersionOverride
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
        verbose: options.verbose,
        downloadCache: options.downloadCache,
        downloadCacheDir: options.downloadCacheDir,
        npmRegistryMirror: options.npmRegistryMirror,
        pm2VersionOverride: options.pm2VersionOverride
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
        verbose: options.verbose,
        downloadCache: options.downloadCache,
        downloadCacheDir: options.downloadCacheDir,
        npmRegistryMirror: options.npmRegistryMirror,
        pm2VersionOverride: options.pm2VersionOverride
      })
    }
  } else {
    const componentDataHome = getComponentRuntimeDataHome(
      paths,
      component.name,
      component.runtimeDataDir
    )
    await cleanupManagedComponent(
      [paths.root, paths.runtimeHome, paths.runtimeDataRoot],
      componentRoot,
      ...(options.purge ? [componentDataHome] : [])
    )
  }

  const isRemoval = action.phase === "remove"
  const managedProgramPaths = [componentRoot]
  const componentDataHome = getComponentRuntimeDataHome(
    paths,
    component.name,
    component.runtimeDataDir
  )
  const componentLogsDir = getComponentLogsDirectory(
    paths,
    component.name,
    component.runtimeDataDir
  )
  const componentPm2Home = component.pm2
    ? getComponentPm2Home(
        paths,
        component.name,
        component.runtimeDataDir,
        component.pm2.pm2Home
      )
    : null
  const managedDataPaths =
    options.purge || !isRemoval
      ? [
          componentDataHome,
          componentConfigDir,
          componentLogsDir,
          ...(componentPm2Home ? [componentPm2Home] : [])
        ]
      : []
  const details =
    component.type === "released-service"
      ? buildReleasedServiceDetails(component, componentRoot, componentDataHome, isRemoval)
      : undefined

  return {
    name: component.name,
    type: component.type,
    status: isRemoval ? "removed" : "installed",
    version: isRemoval ? null : component.version ?? component.channelVersion ?? null,
    managedProgramPaths,
    managedDataPaths,
    managedPaths: [...managedProgramPaths, ...managedDataPaths],
    lastAction: action.phase,
    lastUpdatedAt: new Date().toISOString(),
    logFile: logFilePath,
    details
  }
}

function selectRequestedComponents(
  manifest: LoadedRuntimeManifest,
  requestedComponents: readonly string[] | undefined,
  phase: RuntimeLifecyclePhase
): Set<string> {
  const requestedSet =
    !requestedComponents || requestedComponents.length === 0
      ? new Set(manifest.components.map((component) => component.name))
      : new Set<string>()

  if (requestedComponents && requestedComponents.length > 0) {
    for (const value of requestedComponents) {
      if (!manifest.componentMap.has(value)) {
        throw new RuntimeLifecycleError(`Unknown runtime component: ${value}`)
      }

      requestedSet.add(value)
    }
  }

  if (phase === "remove") {
    return requestedSet
  }

  const queue = [...requestedSet]
  while (queue.length > 0) {
    const componentName = queue.shift()
    if (!componentName) {
      continue
    }

    const component = manifest.componentMap.get(componentName)
    if (!component) {
      throw new RuntimeLifecycleError(`Unknown runtime component: ${componentName}`)
    }

    for (const dependencyName of component.lifecycleDependencies) {
      if (!manifest.componentMap.has(dependencyName)) {
        throw new RuntimeLifecycleError(
          `Runtime component ${component.name} depends on unknown component ${dependencyName}`
        )
      }

      if (!requestedSet.has(dependencyName)) {
        requestedSet.add(dependencyName)
        queue.push(dependencyName)
      }
    }
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
  if (component.name === "node") {
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

async function ensureManagedDirectories(paths: ResolvedRuntimePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.runtimeHome, { recursive: true }),
    mkdir(paths.runtimeDataRoot, { recursive: true }),
    mkdir(paths.bin, { recursive: true }),
    mkdir(paths.config, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.componentsRoot, { recursive: true }),
    mkdir(paths.componentDataRoot, { recursive: true }),
    mkdir(paths.vendoredRoot, { recursive: true })
  ])
}


  function shouldEnsureManagedPm2(
    plan: readonly RuntimePlannedAction[],
    manifest: LoadedRuntimeManifest
  ): boolean {
    return plan.some((action) => manifest.componentMap.get(action.componentName)?.pm2)
  }

  export interface ManagedPm2EnsureResult {
    changed: boolean
    installedVersion: string | null
    selector: string
    prefix: string
  }

  export async function ensureManagedPm2Package(
    manifest: LoadedRuntimeManifest,
    paths: ResolvedRuntimePaths,
    options: Pick<RuntimeLifecycleOptions, "npmRegistryMirror" | "pm2VersionOverride"> = {}
  ): Promise<ManagedPm2EnsureResult> {
    const verification = await verifyNodeRuntime(paths.nodeRuntime)
    if (!verification.valid || !verification.npmPath) {
      throw new RuntimeLifecycleError(
        "Managed Node runtime is missing. Install the runtime node component before ensuring pm2."
      )
    }

    const requirement = resolveManagedPm2Requirement(manifest, options.pm2VersionOverride)
    await ensureManagedNpmPrefix(paths.npmPrefix)

    const npmOptions: NpmGlobalCommandOptions = {
      prefix: paths.npmPrefix,
      registryMirror: options.npmRegistryMirror,
      env: createManagedNpmInstallEnvironment(paths.nodeRuntime)
    }
    const inventoryResult = await listGlobalPackages(verification.npmPath, npmOptions)
    const installedVersion = parseInstalledGlobalPackageVersion(inventoryResult.stdout, "pm2")

    if (installedVersion && isManagedPm2RequirementSatisfied(installedVersion, requirement.range)) {
      return {
        changed: false,
        installedVersion,
        selector: requirement.selector,
        prefix: paths.npmPrefix
      }
    }

    await installGlobalPackage(verification.npmPath, requirement.selector, npmOptions)
    return {
      changed: true,
      installedVersion,
      selector: requirement.selector,
      prefix: paths.npmPrefix
    }
  }

  function resolveManagedPm2Requirement(
    manifest: LoadedRuntimeManifest,
    override: string | undefined
  ): { range: string; selector: string } {
    const normalizedOverride = override?.trim()
    if (normalizedOverride) {
      return {
        range: normalizedOverride.startsWith("pm2@")
          ? normalizedOverride.slice("pm2@".length)
          : normalizedOverride,
        selector: normalizedOverride.startsWith("pm2@")
          ? normalizedOverride
          : `pm2@${normalizedOverride}`
      }
    }

    if (manifest.npmSync) {
      try {
        const npmManifest = validateNpmSyncManifest(manifest.npmSync)
        const entry = npmManifest.packages.pm2
        if (entry) {
          const target = entry.target?.trim()
          if (target) {
            return {
              range: target.startsWith("pm2@") ? target.slice("pm2@".length) : target,
              selector: target.startsWith("pm2@") ? target : `pm2@${target}`
            }
          }

          return {
            range: entry.version,
            selector: `pm2@${entry.version}`
          }
        }
      } catch (error) {
        throw new RuntimeLifecycleError(
          "Runtime manifest npmSync configuration is invalid for managed pm2 resolution.",
          error instanceof Error ? { cause: error } : undefined
        )
      }
    }

    return {
      range: DEFAULT_MANAGED_PM2_VERSION,
      selector: `pm2@${DEFAULT_MANAGED_PM2_VERSION}`
    }
  }

  async function ensureManagedNpmPrefix(prefix: string): Promise<void> {
    const requiredDirectories =
      process.platform === "win32"
        ? [join(prefix, "node_modules")]
        : [join(prefix, "lib", "node_modules"), join(prefix, "bin")]

    await Promise.all(requiredDirectories.map((directory) => mkdir(directory, { recursive: true })))
  }

  function createManagedNpmInstallEnvironment(
    runtimePath: string,
    baseEnv: NodeJS.ProcessEnv = process.env
  ): NodeJS.ProcessEnv {
    const runtimeBinDirectory = dirname(getRuntimeExecutablePaths(runtimePath).nodePath)
    const pathKey = process.platform === "win32" ? "Path" : "PATH"
    const existingPath =
      process.platform === "win32" ? (baseEnv.Path ?? baseEnv.PATH ?? "") : (baseEnv.PATH ?? "")

    return {
      ...baseEnv,
      [pathKey]: [runtimeBinDirectory, existingPath].filter(Boolean).join(
        process.platform === "win32" ? ";" : ":"
      )
    }
  }

  function parseInstalledGlobalPackageVersion(
    inventoryOutput: string,
    packageName: string
  ): string | null {
    try {
      const parsed = JSON.parse(inventoryOutput) as {
        dependencies?: Record<string, { version?: string }>
      }
      return parsed.dependencies?.[packageName]?.version?.trim() || null
    } catch {
      return null
    }
  }

  function isManagedPm2RequirementSatisfied(installedVersion: string, range: string): boolean {
    if (range === "*") {
      return true
    }

    return semver.validRange(range, { includePrerelease: true })
      ? semver.satisfies(installedVersion, range, { includePrerelease: true })
      : installedVersion === range
  }
async function cleanupManagedComponent(
  allowedRoots: readonly string[],
  ...paths: string[]
): Promise<void> {
  for (const pathValue of paths) {
    if (!allowedRoots.some((rootPath) => isPathInsideRuntimeRoot(rootPath, pathValue))) {
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

  if (process.platform !== "win32") {
    await chmod(wrapperPath, 0o755)
  }

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

async function cleanupManagedPm2Service(
  component: RuntimeComponentDefinition,
  manifest: LoadedRuntimeManifest,
  paths: ResolvedRuntimePaths,
  options: RuntimeLifecycleOptions,
  logFilePath: string
): Promise<void> {
  const service = asManagedPm2ServiceName(component.name)
  if (!service || !component.pm2) {
    return
  }

  try {
    const stopResult = await runManagedPm2Command({
      manifestPath: manifest.manifestPath,
      runtimeRoot: paths.root,
      service,
      action: "stop"
    })
    await writeRuntimeLog(
      logFilePath,
      `${component.name} PM2 stop result: ${stopResult.status} (${stopResult.appName})`
    )

    const deleteResult = await runManagedPm2Command({
      manifestPath: manifest.manifestPath,
      runtimeRoot: paths.root,
      service,
      action: "delete"
    })
    await writeRuntimeLog(
      logFilePath,
      `${component.name} PM2 delete result: ${deleteResult.status} (${deleteResult.appName})`
    )
  } catch (error) {
    if (error instanceof ManagedPm2Error && options.verbose) {
      await writeRuntimeLog(logFilePath, `${component.name} PM2 cleanup warning: ${error.message}`)
      return
    }

    throw error
  }
}

function asManagedPm2ServiceName(value: string): ManagedPm2ServiceName | null {
  return supportedPm2Services.includes(value as ManagedPm2ServiceName)
    ? (value as ManagedPm2ServiceName)
    : null
}

function buildReleasedServiceDetails(
  component: RuntimeComponentDefinition,
  componentRoot: string,
  componentDataHome: string,
  isRemoval: boolean
): Record<string, unknown> | undefined {
  if (!component.releasedService) {
    return undefined
  }

  const details: Record<string, unknown> = {
    releasedPayloadPath: resolveReleasedServicePath(component.releasedService.dllPath, componentRoot),
    releasedWorkingDirectory: resolveReleasedServicePath(
      component.releasedService.workingDirectory,
      componentRoot
    ),
    launchAssetsDirectory: join(
      componentDataHome,
      component.releasedService.runtimeFilesDir ?? "pm2-runtime"
    )
  }
  details.releasedServiceReady =
    !isRemoval &&
    existsSync(String(details.releasedPayloadPath)) &&
    existsSync(String(details.releasedWorkingDirectory))

  if (isRemoval) {
    details.cleanupSummary =
      "Released-service PM2 app cleanup completed before launch assets were removed."
  } else {
    details.readinessSummary = details.releasedServiceReady
      ? "Released-service payload validated and launch assets prepared for `hagiscript pm2 server start`."
      : "Released-service launch assets are prepared, but the published backend payload is not staged yet."
  }

  return details
}

async function resolveNodeRuntimeForPhase(
  phase: RuntimeLifecyclePhase,
  targetDirectory: string,
  desiredVersion: string | undefined,
  currentVerification: Awaited<ReturnType<typeof verifyNodeRuntime>>,
  downloadCache: boolean | undefined,
  downloadCacheDir: string | undefined
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
      versionSelector: desiredVersion,
      downloadCacheEnabled: downloadCache,
      downloadCacheDirectory: downloadCacheDir
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
    versionSelector: desiredVersion,
    downloadCacheEnabled: downloadCache,
    downloadCacheDirectory: downloadCacheDir
  })
}
