import { appendFile, mkdir } from "node:fs/promises"
import { basename, dirname, extname } from "node:path"
import process from "node:process"
import type { CommandRunner } from "./command-launch.js"
import { runCommand } from "./command-launch.js"
import type {
  LoadedRuntimeManifest,
  RuntimeComponentDefinition,
  RuntimeLifecyclePhase
} from "./runtime-manifest.js"
import type { ResolvedRuntimePaths } from "./runtime-paths.js"

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
  return withManagedBinPath(
    {
      ...process.env,
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
      HAGISCRIPT_RUNTIME_PHASE: context.phase,
      HAGISCRIPT_RUNTIME_PURGE: context.purge ? "1" : "0",
      HAGISCRIPT_RUNTIME_VERBOSE: context.verbose ? "1" : "0",
      HAGISCRIPT_RUNTIME_SCRIPT_BASENAME: basename(scriptPathForEnv(context.component, context.phase))
    },
    context.paths.bin
  )
}

function withManagedBinPath(
  env: NodeJS.ProcessEnv,
  binPath: string
): NodeJS.ProcessEnv {
  const pathKey = process.platform === "win32" ? "Path" : "PATH"
  const currentPath = env[pathKey] ?? env.PATH ?? ""

  return {
    ...env,
    [pathKey]: [binPath, currentPath].filter(Boolean).join(process.platform === "win32" ? ";" : ":")
  }
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
