import { appendFile, mkdir } from "node:fs/promises"
import { basename, dirname, extname } from "node:path"
import process from "node:process"
import { CommandExecutionError, runCommand, type CommandRunner } from "./command-launch.js"
import { getRuntimeExecutablePaths } from "./node-verify.js"
import type {
  LoadedRuntimeManifest,
  RuntimeComponentDefinition,
  RuntimeLifecyclePhase,
  RuntimeReleasedServiceDefinition
} from "./runtime-manifest.js"
import type { ResolvedRuntimePaths } from "./runtime-paths.js"
import {
  getComponentLogsDirectory,
  getComponentPm2Home,
  getComponentRuntimeDataHome,
  resolveReleasedServicePath
} from "./runtime-paths.js"

export interface RuntimeScriptExecutionContext {
  component: RuntimeComponentDefinition
  phase: RuntimeLifecyclePhase
  manifest: LoadedRuntimeManifest
  paths: ResolvedRuntimePaths
  componentRoot: string
  componentConfigDir: string
  logFilePath?: string
  purge?: boolean
  verbose?: boolean
  downloadCache?: boolean
  downloadCacheDir?: string
  npmRegistryMirror?: string
  pm2VersionOverride?: string
  runner?: CommandRunner
}

export interface ManagedRuntimeEnvironmentContext {
  component: Pick<
    RuntimeComponentDefinition,
    | "name"
    | "type"
    | "version"
    | "runtimeDataDir"
    | "releasedService"
    | "bundledInstallMode"
  >
  manifest: Pick<LoadedRuntimeManifest, "manifestDir">
  paths: ResolvedRuntimePaths
  componentRoot: string
  componentConfigDir: string
  componentDataHome?: string
  componentLogsDir?: string
  pm2Home?: string
  phase?: string
  purge?: boolean
  verbose?: boolean
  downloadCache?: boolean
  downloadCacheDir?: string
  npmRegistryMirror?: string
  pm2VersionOverride?: string
  scriptBasename?: string
  includeNpmConfigPrefix?: boolean
}

export interface RuntimeScriptExecutionResult {
  command: string
  args: string[]
  stdout: string
  stderr: string
}

export async function executeRuntimeScript(
  scriptPath: string,
  context: RuntimeScriptExecutionContext
): Promise<RuntimeScriptExecutionResult> {
  const runner = context.runner ?? runCommand
  const { command, args } = getRuntimeScriptLaunch(scriptPath)

  try {
    const result = await runner(command, args, {
      cwd: context.manifest.manifestDir,
      env: buildRuntimeScriptEnvironment(context),
      maxBuffer: 10 * 1024 * 1024
    })

    if (context.logFilePath) {
      await writeRuntimeLog(
        context.logFilePath,
        [
          `# ${context.phase}:${context.component.name}`,
          `$ ${command} ${args.join(" ")}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      )
    }

    return {
      command,
      args,
      stdout: result.stdout,
      stderr: result.stderr
    }
  } catch (error) {
    if (context.logFilePath) {
      const lines = [
        `# ${context.phase}:${context.component.name}`,
        `$ ${command} ${args.join(" ")}`,
        error instanceof Error ? `failure:\n${error.message}` : `failure:\n${String(error)}`
      ]

      if (error instanceof CommandExecutionError) {
        if (error.context.stdout) {
          lines.push(`stdout:\n${error.context.stdout}`)
        }
        if (error.context.stderr) {
          lines.push(`stderr:\n${error.context.stderr}`)
        }
      }

      await writeRuntimeLog(context.logFilePath, lines.join("\n"))
    }

    if (error instanceof CommandExecutionError) {
      const detail = [
        error.message,
        error.context.stdout ? `stdout:\n${error.context.stdout}` : "",
        error.context.stderr ? `stderr:\n${error.context.stderr}` : ""
      ]
        .filter(Boolean)
        .join("\n")

      throw new Error(detail, { cause: error })
    }

    throw error
  }
}

export async function writeRuntimeLog(logFilePath: string, content: string): Promise<void> {
  await mkdir(dirname(logFilePath), { recursive: true })
  await appendFile(logFilePath, `${content}\n`, "utf8")
}

export function getRuntimeScriptLaunch(scriptPath: string): {
  command: string
  args: string[]
} {
  const extension = extname(scriptPath).toLowerCase()

  if (extension === ".mjs" || extension === ".js" || extension === ".cjs") {
    return {
      command: process.execPath,
      args: [scriptPath]
    }
  }

  return {
    command: scriptPath,
    args: []
  }
}

function buildRuntimeScriptEnvironment(
  context: RuntimeScriptExecutionContext
): NodeJS.ProcessEnv {
  return buildManagedRuntimeEnvironment({
    component: context.component,
    manifest: context.manifest,
    paths: context.paths,
    componentRoot: context.componentRoot,
    componentConfigDir: context.componentConfigDir,
    componentDataHome: getComponentRuntimeDataHome(
      context.paths,
      context.component.name,
      context.component.runtimeDataDir
    ),
    componentLogsDir: getComponentLogsDirectory(
      context.paths,
      context.component.name,
      context.component.runtimeDataDir
    ),
    pm2Home: getComponentPm2Home(
      context.paths,
      context.component.name,
      context.component.runtimeDataDir,
      context.component.pm2?.pm2Home
    ),
    phase: context.phase,
    purge: context.purge,
    verbose: context.verbose,
    npmRegistryMirror: context.npmRegistryMirror,
    pm2VersionOverride: context.pm2VersionOverride,
    scriptBasename: basename(scriptPathForEnv(context.component, context.phase))
  })
}

export function buildManagedRuntimeEnvironment(
  context: ManagedRuntimeEnvironmentContext,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const runtimeExecutables = getRuntimeExecutablePaths(context.paths.nodeRuntime)
  const bundledNpmModulesDirectory = getManagedNpmModulesDirectory(context.paths.npmPrefix)
  const managedNpmPackagesPrefix = getManagedNpmPackagesPrefix(context.paths)
  const managedNpmBinDirectory = getManagedNpmBinDirectory(managedNpmPackagesPrefix)
  const managedNpmModulesDirectory = getManagedNpmModulesDirectory(managedNpmPackagesPrefix)
  const componentDataHome =
    context.componentDataHome ??
    getComponentRuntimeDataHome(
      context.paths,
      context.component.name,
      context.component.runtimeDataDir
    )
  const componentLogsDir =
    context.componentLogsDir ??
    getComponentLogsDirectory(
      context.paths,
      context.component.name,
      context.component.runtimeDataDir
    )
  const pm2Home =
    context.pm2Home ??
    getComponentPm2Home(
      context.paths,
      context.component.name,
      context.component.runtimeDataDir,
      undefined
    )
  const includeNpmConfigPrefix = context.includeNpmConfigPrefix !== false
  const resolvedBaseEnv: NodeJS.ProcessEnv = { ...baseEnv }

  if (!includeNpmConfigPrefix) {
    delete resolvedBaseEnv.NPM_CONFIG_PREFIX
    delete resolvedBaseEnv.npm_config_prefix
  }

  return prependPathEntries(
    {
      ...resolvedBaseEnv,
      HAGICODE_RUNTIME_HOME: context.paths.runtimeHome,
      HAGICODE_RUNTIME_DATA_HOME: componentDataHome,
      PM2_HOME: pm2Home,
      HAGISCRIPT_RUNTIME_ROOT: context.paths.root,
      HAGISCRIPT_RUNTIME_BIN_DIR: context.paths.bin,
      HAGISCRIPT_RUNTIME_CONFIG_DIR: context.paths.config,
      HAGISCRIPT_RUNTIME_LOGS_DIR: context.paths.logs,
      HAGISCRIPT_RUNTIME_DATA_DIR: context.paths.data,
      HAGISCRIPT_RUNTIME_STATE_PATH: context.paths.stateFile,
      HAGISCRIPT_RUNTIME_TEMPLATE_DIR: `${context.manifest.manifestDir}/templates`,
      HAGISCRIPT_RUNTIME_COMPONENT_NAME: context.component.name,
      HAGISCRIPT_RUNTIME_COMPONENT_TYPE: context.component.type,
      HAGISCRIPT_RUNTIME_COMPONENT_VERSION: context.component.version ?? "",
      HAGISCRIPT_RUNTIME_BUNDLED_INSTALL_MODE: context.component.bundledInstallMode,
      HAGISCRIPT_RUNTIME_COMPONENT_ROOT: context.componentRoot,
      HAGISCRIPT_RUNTIME_COMPONENT_CONFIG_DIR: context.componentConfigDir,
      HAGISCRIPT_RUNTIME_COMPONENT_DATA_DIR: componentDataHome,
      HAGISCRIPT_RUNTIME_COMPONENT_LOGS_DIR: componentLogsDir,
      HAGISCRIPT_RUNTIME_COMPONENT_PM2_HOME: pm2Home,
      HAGISCRIPT_RUNTIME_NODE_RUNTIME_DIR: context.paths.nodeRuntime,
      HAGISCRIPT_RUNTIME_DOTNET_RUNTIME_DIR: context.paths.dotnetRuntime,
      HAGISCRIPT_RUNTIME_NPM_PREFIX: context.paths.npmPrefix,
      HAGISCRIPT_RUNTIME_NPM_PACKAGES_PREFIX: managedNpmPackagesPrefix,
      NODE_PATH: prependNodePathEntries(baseEnv.NODE_PATH, [
        managedNpmModulesDirectory,
        bundledNpmModulesDirectory
      ]),
      NODE: runtimeExecutables.nodePath,
      npm_node_execpath: runtimeExecutables.nodePath,
      npm_execpath: runtimeExecutables.npmPath,
      HAGICODE_AGENT_CLI_PATH: managedNpmBinDirectory,
      HAGICODE_NPM_GLOBAL_PATH: managedNpmPackagesPrefix,
      HAGICODE_NPM_GLOBAL_PREFIX: managedNpmPackagesPrefix,
      HAGICODE_NPM_GLOBAL_BIN_ROOT: managedNpmBinDirectory,
      HAGICODE_NPM_GLOBAL_MODULES_ROOT: managedNpmModulesDirectory,
      ...(includeNpmConfigPrefix
        ? {
            NPM_CONFIG_PREFIX: managedNpmPackagesPrefix,
            npm_config_prefix: managedNpmPackagesPrefix
          }
        : {}),
      ...buildReleasedServiceEnvironment(context.component.releasedService, context.componentRoot),
      ...(context.phase ? { HAGISCRIPT_RUNTIME_PHASE: context.phase } : {}),
      ...(context.purge !== undefined
        ? { HAGISCRIPT_RUNTIME_PURGE: context.purge ? "1" : "0" }
        : {}),
      ...(context.verbose !== undefined
        ? { HAGISCRIPT_RUNTIME_VERBOSE: context.verbose ? "1" : "0" }
        : {}),
      HAGISCRIPT_DOWNLOAD_CACHE: context.downloadCache === false ? "0" : "1",
      ...(context.downloadCacheDir
        ? { HAGISCRIPT_DOWNLOAD_CACHE_DIR: context.downloadCacheDir }
        : {}),
      ...(context.npmRegistryMirror
        ? { HAGISCRIPT_RUNTIME_NPM_REGISTRY_MIRROR: context.npmRegistryMirror }
        : {}),
      ...(context.pm2VersionOverride
        ? { HAGISCRIPT_RUNTIME_PM2_VERSION_OVERRIDE: context.pm2VersionOverride }
        : {}),
      ...(context.scriptBasename
        ? { HAGISCRIPT_RUNTIME_SCRIPT_BASENAME: context.scriptBasename }
        : {})
    },
    getManagedRuntimePathEntries(context.paths, {
      includeRuntimeBin: shouldIncludeManagedRuntimeBin(context.component)
    })
  )
}

function buildReleasedServiceEnvironment(
  releasedService: RuntimeReleasedServiceDefinition | undefined,
  componentRoot: string
): NodeJS.ProcessEnv {
  if (!releasedService) {
    return {}
  }

  return {
    HAGISCRIPT_RUNTIME_RELEASED_SERVICE_DLL_PATH: releasedService.dllPath,
    HAGISCRIPT_RUNTIME_RELEASED_SERVICE_DLL_ABSOLUTE_PATH: resolveReleasedServicePath(
      releasedService.dllPath,
      componentRoot
    ),
    HAGISCRIPT_RUNTIME_RELEASED_SERVICE_WORKING_DIRECTORY: releasedService.workingDirectory,
    HAGISCRIPT_RUNTIME_RELEASED_SERVICE_WORKING_DIRECTORY_ABSOLUTE_PATH:
      resolveReleasedServicePath(releasedService.workingDirectory, componentRoot),
    ...(releasedService.configRoot
      ? {
          HAGISCRIPT_RUNTIME_RELEASED_SERVICE_CONFIG_ROOT: releasedService.configRoot,
          HAGISCRIPT_RUNTIME_RELEASED_SERVICE_CONFIG_ROOT_ABSOLUTE_PATH:
            resolveReleasedServicePath(releasedService.configRoot, componentRoot)
        }
      : {}),
    ...(releasedService.runtimeFilesDir
      ? {
          HAGISCRIPT_RUNTIME_RELEASED_SERVICE_RUNTIME_FILES_DIR: releasedService.runtimeFilesDir
        }
      : {}),
    ...(releasedService.startScript
      ? {
          HAGISCRIPT_RUNTIME_RELEASED_SERVICE_START_SCRIPT: releasedService.startScript,
          HAGISCRIPT_RUNTIME_RELEASED_SERVICE_START_SCRIPT_ABSOLUTE_PATH:
            resolveReleasedServicePath(releasedService.startScript, componentRoot)
        }
      : {})
  }
}

export function prependPathEntries(
  env: NodeJS.ProcessEnv,
  pathEntries: readonly string[],
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const pathKey = platform === "win32" ? "Path" : "PATH"
  const currentPath = getPathValue(env, platform)
  const environmentWithoutPath = stripPathKeys(env, platform)

  return {
    ...environmentWithoutPath,
    [pathKey]: [...pathEntries, currentPath]
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":")
  }
}

export function getManagedRuntimePathEntries(
  paths: ResolvedRuntimePaths,
  options: {
    includeRuntimeBin?: boolean
  } = {}
): string[] {
  const nodeExecutables = getRuntimeExecutablePaths(paths.nodeRuntime)
  return [
    dirname(nodeExecutables.nodePath),
    getManagedNpmBinDirectory(getManagedNpmPackagesPrefix(paths)),
    getManagedNpmBinDirectory(paths.npmPrefix),
    ...(options.includeRuntimeBin === false ? [] : [paths.bin])
  ]
}

function shouldIncludeManagedRuntimeBin(
  component: Pick<RuntimeComponentDefinition, "type">
): boolean {
  return component.type !== "released-service"
}

export function getManagedNpmPackagesPrefix(paths: ResolvedRuntimePaths): string {
  return paths.npmPrefix
}

export function getManagedNpmBinDirectory(npmPrefix: string): string {
  return process.platform === "win32" ? npmPrefix : `${npmPrefix}/bin`
}

export function getManagedNpmModulesDirectory(npmPrefix: string): string {
  return process.platform === "win32"
    ? `${npmPrefix}/node_modules`
    : `${npmPrefix}/lib/node_modules`
}

function prependNodePathEntries(
  currentNodePath: string | undefined,
  pathEntries: readonly string[],
  platform: NodeJS.Platform = process.platform
): string {
  const delimiter = platform === "win32" ? ";" : ":"
  const normalizedEntries = dedupeEntries(
    [...pathEntries, ...(currentNodePath?.split(delimiter) ?? [])].filter(Boolean)
  )

  return normalizedEntries.join(delimiter)
}

function dedupeEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const entry of entries) {
    const normalized = entry.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    unique.push(normalized)
  }

  return unique
}

function getPathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return env.PATH ?? ""
  }

  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path" && typeof value === "string") {
      return value
    }
  }

  return ""
}

function stripPathKeys(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return { ...env }
  }

  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== "path")
  )
}

function scriptPathForEnv(
  component: RuntimeComponentDefinition,
  phase: RuntimeLifecyclePhase
): string {
  switch (phase) {
    case "install":
      return component.scripts.install
    case "remove":
      return component.scripts.remove ?? component.scripts.install
    case "update":
      return component.scripts.update ?? component.scripts.install
  }
}
