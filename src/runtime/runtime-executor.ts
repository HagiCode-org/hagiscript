import { appendFile, mkdir } from "node:fs/promises"
import { basename, dirname, extname } from "node:path"
import process from "node:process"
import type { CommandRunner } from "./command-launch.js"
import { runCommand } from "./command-launch.js"
import { getRuntimeExecutablePaths } from "./node-verify.js"
import type {
  LoadedRuntimeManifest,
  RuntimeComponentDefinition,
  RuntimeLifecyclePhase
} from "./runtime-manifest.js"
import type { ResolvedRuntimePaths } from "./runtime-paths.js"
import {
  getComponentLogsDirectory,
  getComponentPm2Home,
  getComponentRuntimeDataHome
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
  runner?: CommandRunner
}

export interface ManagedRuntimeEnvironmentContext {
  component: Pick<RuntimeComponentDefinition, "name" | "type" | "version" | "runtimeDataDir">
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
  scriptBasename?: string
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
    scriptBasename: basename(scriptPathForEnv(context.component, context.phase))
  })
}

export function buildManagedRuntimeEnvironment(
  context: ManagedRuntimeEnvironmentContext,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
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

  return prependPathEntries(
    {
      ...baseEnv,
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
      HAGISCRIPT_RUNTIME_COMPONENT_ROOT: context.componentRoot,
      HAGISCRIPT_RUNTIME_COMPONENT_CONFIG_DIR: context.componentConfigDir,
      HAGISCRIPT_RUNTIME_COMPONENT_DATA_DIR: componentDataHome,
      HAGISCRIPT_RUNTIME_COMPONENT_LOGS_DIR: componentLogsDir,
      HAGISCRIPT_RUNTIME_COMPONENT_PM2_HOME: pm2Home,
      ...(context.phase ? { HAGISCRIPT_RUNTIME_PHASE: context.phase } : {}),
      ...(context.purge !== undefined
        ? { HAGISCRIPT_RUNTIME_PURGE: context.purge ? "1" : "0" }
        : {}),
      ...(context.verbose !== undefined
        ? { HAGISCRIPT_RUNTIME_VERBOSE: context.verbose ? "1" : "0" }
        : {}),
      ...(context.scriptBasename
        ? { HAGISCRIPT_RUNTIME_SCRIPT_BASENAME: context.scriptBasename }
        : {})
    },
    getManagedRuntimePathEntries(context.paths)
  )
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

export function getManagedRuntimePathEntries(paths: ResolvedRuntimePaths): string[] {
  const nodeExecutables = getRuntimeExecutablePaths(paths.nodeRuntime)
  return [
    dirname(nodeExecutables.nodePath),
    getManagedNpmBinDirectory(paths.npmPrefix),
    paths.bin
  ]
}

export function getManagedNpmBinDirectory(npmPrefix: string): string {
  return process.platform === "win32" ? npmPrefix : `${npmPrefix}/bin`
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
