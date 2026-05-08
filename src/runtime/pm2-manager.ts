import { access, mkdir, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import process from "node:process"
import type { CommandResult, CommandRunner } from "./command-launch.js"
import { CommandExecutionError, runCommand } from "./command-launch.js"
import {
  buildManagedRuntimeEnvironment,
  getManagedRuntimePathEntries
} from "./runtime-executor.js"
import { getRuntimeExecutablePaths } from "./node-verify.js"
import {
  loadRuntimeManifest,
  type LoadedRuntimeManifest,
  type RuntimeComponentDefinition
} from "./runtime-manifest.js"
import {
  getComponentConfigDirectory,
  getComponentManagedRoot,
  getComponentPm2Home,
  getComponentRuntimeDataHome,
  resolveManagedPath,
  resolveReleasedServicePath,
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"

export const supportedPm2Services = ["server", "omniroute", "code-server"] as const

export type ManagedPm2ServiceName = (typeof supportedPm2Services)[number]
export type ManagedPm2Action = "start" | "stop" | "restart" | "status" | "delete"
export type ManagedPm2Status = "online" | "stopped" | "errored" | "missing" | "unknown"

export interface ManagedPm2CommandOptions {
  manifestPath?: string
  runtimeRoot?: string
  service: ManagedPm2ServiceName
  action: ManagedPm2Action
  runner?: CommandRunner
}

type ManagedPm2LaunchStrategy = "node-script" | "released-service"

export interface ResolvedManagedPm2ServiceDefinition {
  service: ManagedPm2ServiceName
  component: RuntimeComponentDefinition
  manifestDir: string
  paths: ResolvedRuntimePaths
  appName: string
  cwd: string
  script: string
  args: string[]
  env: Record<string, string>
  runtimeHome: string
  runtimeDataHome: string
  componentRoot: string
  componentConfigDir: string
  pm2Home: string
  pm2Binary: string
  nodePath: string
  launchStrategy: ManagedPm2LaunchStrategy
  dotnetPath?: string
  runtimeFilesDir?: string
  ecosystemPath?: string
  envFilePath?: string
}

export interface ManagedPm2CommandResult {
  service: ManagedPm2ServiceName
  action: ManagedPm2Action
  appName: string
  cwd: string
  script: string
  runtimeHome: string
  runtimeDataHome: string
  pm2Home: string
  pm2Binary: string
  exists: boolean
  status: ManagedPm2Status
  pid: number | null
  stdout: string
  stderr: string
  launchStrategy: ManagedPm2LaunchStrategy
  dotnetPath?: string
  runtimeFilesDir?: string
}

export interface ManagedPm2EnvironmentResult {
  service: ManagedPm2ServiceName
  appName: string
  cwd: string
  script: string
  args: string[]
  env: NodeJS.ProcessEnv
  pathKey: "PATH" | "Path"
  pathEntries: string[]
  runtimeHome: string
  runtimeDataHome: string
  componentRoot: string
  componentConfigDir: string
  pm2Home: string
  pm2Binary: string
  nodePath: string
  launchStrategy: ManagedPm2LaunchStrategy
  dotnetPath?: string
  runtimeFilesDir?: string
  ecosystemPath?: string
  envFilePath?: string
}

export class ManagedPm2Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ManagedPm2Error"
  }
}

const DEFAULT_PM2_STATUS_RETRY_DELAY_MS = 500
const DEFAULT_PM2_STATUS_MAX_RETRIES = 3

export async function runManagedPm2Command(
  options: ManagedPm2CommandOptions
): Promise<ManagedPm2CommandResult> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const definition = await resolveManagedPm2ServiceDefinition(manifest, paths, options.service)
  const runner = options.runner ?? runCommand

  switch (options.action) {
    case "start":
      if (definition.launchStrategy === "released-service") {
        await prepareReleasedServicePm2Files(definition)
      }
      await executePm2(definition, buildPm2ActionArgs(definition, "start"), runner)
      return readManagedPm2Status(definition, "start", runner)
    case "restart":
      if (definition.launchStrategy === "released-service") {
        await prepareReleasedServicePm2Files(definition)
      }
      await executePm2(definition, buildPm2ActionArgs(definition, "restart"), runner)
      return readManagedPm2Status(definition, "restart", runner)
    case "stop":
      await executePm2(definition, buildPm2ActionArgs(definition, "stop"), runner, {
        allowMissingProcess: true
      })
      return readManagedPm2Status(definition, "stop", runner)
    case "delete":
      await executePm2(definition, buildPm2ActionArgs(definition, "delete"), runner, {
        allowMissingProcess: true
      })
      return readManagedPm2Status(definition, "delete", runner)
    case "status":
      return readManagedPm2Status(definition, "status", runner)
  }
}

export async function resolveManagedPm2Environment(
  options: Omit<ManagedPm2CommandOptions, "action" | "runner">
): Promise<ManagedPm2EnvironmentResult> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const definition = await resolveManagedPm2ServiceDefinition(manifest, paths, options.service)
  const env = buildManagedPm2Environment(definition)

  return {
    service: definition.service,
    appName: definition.appName,
    cwd: definition.cwd,
    script: definition.script,
    args: [...definition.args],
    env,
    pathKey: process.platform === "win32" ? "Path" : "PATH",
    pathEntries: getManagedRuntimePathEntries(definition.paths),
    runtimeHome: definition.runtimeHome,
    runtimeDataHome: definition.runtimeDataHome,
    componentRoot: definition.componentRoot,
    componentConfigDir: definition.componentConfigDir,
    pm2Home: definition.pm2Home,
    pm2Binary: definition.pm2Binary,
    nodePath: definition.nodePath,
    launchStrategy: definition.launchStrategy,
    dotnetPath: definition.dotnetPath,
    runtimeFilesDir: definition.runtimeFilesDir,
    ecosystemPath: definition.ecosystemPath,
    envFilePath: definition.envFilePath
  }
}

export async function resolveManagedPm2ServiceDefinition(
  manifest: LoadedRuntimeManifest,
  paths: ResolvedRuntimePaths,
  service: ManagedPm2ServiceName
): Promise<ResolvedManagedPm2ServiceDefinition> {
  assertSupportedPm2Service(service)

  const component = manifest.componentMap.get(service)
  if (!component) {
    throw new ManagedPm2Error(`Runtime manifest does not define the ${service} service.`)
  }

  const componentRoot = getComponentManagedRoot(paths, component.name)
  const runtimeDataHome = getComponentRuntimeDataHome(
    paths,
    component.name,
    component.runtimeDataDir
  )
  const componentConfigDir = getComponentConfigDirectory(
    paths,
    component.name,
    component.runtimeDataDir
  )
  const pm2Home = getComponentPm2Home(
    paths,
    component.name,
    component.runtimeDataDir,
    component.pm2?.pm2Home
  )
  const nodePath = getRuntimeExecutablePaths(paths.nodeRuntime).nodePath
  const pm2Entrypoint = getManagedPm2Entrypoint(paths.npmPrefix)

  await Promise.all([
    validateManagedPath(
      pm2Entrypoint,
      "Managed PM2 binary is missing. Install the runtime npm-packages component first."
    ),
    validateManagedPath(
      nodePath,
      "Managed Node runtime is missing. Install the runtime node component first."
    )
  ])

  if (component.type === "released-service") {
    const releasedService = component.releasedService
    if (!releasedService) {
      throw new ManagedPm2Error(
        `Runtime manifest component ${component.name} is missing releasedService metadata.`
      )
    }

    const cwd = resolveReleasedServicePath(releasedService.workingDirectory, componentRoot)
    const script = resolveReleasedServicePath(releasedService.dllPath, componentRoot)
    const runtimeFilesDir = join(runtimeDataHome, releasedService.runtimeFilesDir ?? "pm2-runtime")
    const ecosystemPath = join(runtimeFilesDir, "ecosystem.config.cjs")
    const envFilePath = join(runtimeFilesDir, ".env")
    const dotnetPath = join(
      paths.dotnetRuntime,
      "current",
      process.platform === "win32" ? "dotnet.exe" : "dotnet"
    )

    await Promise.all([
      validateManagedPath(script, `Managed released-service payload for ${service} is missing.`),
      validateManagedPath(cwd, `Managed working directory for ${service} is missing.`),
      validateManagedPath(
        dotnetPath,
        "Managed .NET runtime is missing. Install the runtime dotnet component first."
      )
    ])

    return {
      service,
      component,
      manifestDir: manifest.manifestDir,
      paths,
      appName: component.pm2?.appName ?? `hagicode-${component.name}`,
      cwd,
      script,
      args: component.pm2?.args ?? [],
      env: component.pm2?.env ?? {},
      runtimeHome: paths.runtimeHome,
      runtimeDataHome,
      componentRoot,
      componentConfigDir,
      pm2Home,
      pm2Binary: pm2Entrypoint,
      nodePath,
      launchStrategy: "released-service",
      dotnetPath,
      runtimeFilesDir,
      ecosystemPath,
      envFilePath
    }
  }

  const script = resolveManagedPath(
    component.pm2?.script ?? defaultPm2Script(component.name),
    componentRoot
  )
  const cwd = resolveManagedPath(component.pm2?.cwd ?? ".", componentRoot)

  await Promise.all([
    validateManagedPath(script, `Managed launcher for ${service} is missing.`),
    validateManagedPath(cwd, `Managed working directory for ${service} is missing.`)
  ])

  return {
    service,
    component,
    manifestDir: manifest.manifestDir,
    paths,
    appName: component.pm2?.appName ?? `hagicode-${component.name}`,
    cwd,
    script,
    args: component.pm2?.args ?? [],
    env: component.pm2?.env ?? {},
    runtimeHome: paths.runtimeHome,
    runtimeDataHome,
    componentRoot,
    componentConfigDir,
    pm2Home,
    pm2Binary: pm2Entrypoint,
    nodePath,
    launchStrategy: "node-script"
  }
}

export function renderManagedPm2StatusText(result: ManagedPm2CommandResult): string {
  return [
    `Service: ${result.service}`,
    `Action: ${result.action}`,
    `App: ${result.appName}`,
    `Status: ${result.status}`,
    `Launch strategy: ${result.launchStrategy}`,
    `Runtime home: ${result.runtimeHome}`,
    `Runtime data home: ${result.runtimeDataHome}`,
    `PM2 home: ${result.pm2Home}`,
    `Script: ${result.script}`,
    `Working directory: ${result.cwd}`,
    `PM2 binary: ${result.pm2Binary}`,
    ...(result.dotnetPath ? [`Dotnet: ${result.dotnetPath}`] : []),
    ...(result.runtimeFilesDir ? [`Runtime files: ${result.runtimeFilesDir}`] : []),
    `PID: ${result.pid ?? "n/a"}`
  ].join("\n")
}

export function renderManagedPm2EnvironmentText(result: ManagedPm2EnvironmentResult): string {
  const argsText =
    result.args.length > 0 ? result.args.map((entry) => JSON.stringify(entry)).join(" ") : "(none)"
  const envLines = Object.entries(result.env)
    .filter(([key, value]) => key.trim().length > 0 && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `  ${key}=${String(value).replace(/\r?\n/g, "\\n")}`)

  return [
    `Service: ${result.service}`,
    `App: ${result.appName}`,
    `Launch strategy: ${result.launchStrategy}`,
    `Working directory: ${result.cwd}`,
    `Script: ${result.script}`,
    `Arguments: ${argsText}`,
    `Runtime home: ${result.runtimeHome}`,
    `Runtime data home: ${result.runtimeDataHome}`,
    `Component root: ${result.componentRoot}`,
    `Component config dir: ${result.componentConfigDir}`,
    `PM2 home: ${result.pm2Home}`,
    `PM2 binary: ${result.pm2Binary}`,
    `Node: ${result.nodePath}`,
    ...(result.dotnetPath ? [`Dotnet: ${result.dotnetPath}`] : []),
    ...(result.runtimeFilesDir ? [`Runtime files: ${result.runtimeFilesDir}`] : []),
    ...(result.ecosystemPath ? [`PM2 ecosystem: ${result.ecosystemPath}`] : []),
    ...(result.envFilePath ? [`PM2 env file: ${result.envFilePath}`] : []),
    `Path key: ${result.pathKey}`,
    "Managed PATH entries:",
    ...result.pathEntries.map((entry) => `  - ${entry}`),
    "Environment:",
    ...envLines
  ].join("\n")
}

function assertSupportedPm2Service(service: string): asserts service is ManagedPm2ServiceName {
  if ((supportedPm2Services as readonly string[]).includes(service)) {
    return
  }

  throw new ManagedPm2Error(
    `Unsupported managed PM2 service "${service}". Supported services: ${supportedPm2Services.join(", ")}.`
  )
}

async function readManagedPm2Status(
  definition: ResolvedManagedPm2ServiceDefinition,
  action: ManagedPm2Action,
  runner: CommandRunner
): Promise<ManagedPm2CommandResult> {
  let result: CommandResult | undefined
  let parsed: ManagedPm2ParsedStatus | undefined

  for (let attempt = 0; attempt <= DEFAULT_PM2_STATUS_MAX_RETRIES; attempt += 1) {
    result = await executePm2(definition, ["jlist"], runner)
    parsed = parseManagedPm2Status(result, definition.appName)

    if (parsed.kind === "status") {
      return {
        service: definition.service,
        action,
        appName: definition.appName,
        cwd: definition.cwd,
        script: definition.script,
        runtimeHome: definition.runtimeHome,
        runtimeDataHome: definition.runtimeDataHome,
        pm2Home: definition.pm2Home,
        pm2Binary: definition.pm2Binary,
        exists: parsed.statusEntry !== null,
        status: parsed.statusEntry?.status ?? "missing",
        pid: parsed.statusEntry?.pid ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
        launchStrategy: definition.launchStrategy,
        dotnetPath: definition.dotnetPath,
        runtimeFilesDir: definition.runtimeFilesDir
      }
    }

    if (parsed.kind === "failure") {
      throw new ManagedPm2Error(parsed.message)
    }

    const retriesRemaining = DEFAULT_PM2_STATUS_MAX_RETRIES - attempt
    if (retriesRemaining <= 0) {
      throw new ManagedPm2Error(
        `Managed PM2 status output could not be normalized after ${attempt + 1} attempt${attempt === 0 ? "" : "s"} during PM2 bootstrap. Last PM2 output: ${parsed.summary}`
      )
    }

    await sleep(DEFAULT_PM2_STATUS_RETRY_DELAY_MS)
  }

  throw new ManagedPm2Error(
    `Managed PM2 status output could not be normalized for ${definition.appName}.`
  )
}

async function executePm2(
  definition: ResolvedManagedPm2ServiceDefinition,
  args: string[],
  runner: CommandRunner,
  options: {
    allowMissingProcess?: boolean
  } = {}
): Promise<CommandResult> {
  const env = buildManagedPm2Environment(definition)

  try {
    return await runner(definition.nodePath, [definition.pm2Binary, ...args], {
      cwd: definition.cwd,
      env,
      maxBuffer: 10 * 1024 * 1024
    })
  } catch (error) {
    if (
      options.allowMissingProcess &&
      error instanceof CommandExecutionError &&
      /not found|doesn't exist|process or namespace/i.test(
        `${error.context.stderr}\n${error.context.stdout}`
      )
    ) {
      return {
        command: error.context.command,
        args: error.context.args,
        stdout: error.context.stdout,
        stderr: error.context.stderr,
        cwd: error.context.cwd,
        exitCode: error.context.exitCode,
        signal: error.context.signal,
        timedOut: error.context.timedOut
      }
    }

    throw new ManagedPm2Error(
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? { cause: error } : undefined
    )
  }
}

async function prepareReleasedServicePm2Files(
  definition: ResolvedManagedPm2ServiceDefinition
): Promise<void> {
  if (
    definition.launchStrategy !== "released-service" ||
    !definition.runtimeFilesDir ||
    !definition.ecosystemPath ||
    !definition.envFilePath ||
    !definition.dotnetPath
  ) {
    return
  }

  const env = buildManagedPm2Environment(definition)

  await mkdir(definition.runtimeFilesDir, { recursive: true })
  await writeFile(definition.envFilePath, buildPm2EnvFile(env), "utf8")
  await writeFile(
    definition.ecosystemPath,
    buildReleasedServiceEcosystemConfig(definition),
    "utf8"
  )
}

function buildReleasedServiceEcosystemConfig(
  definition: ResolvedManagedPm2ServiceDefinition
): string {
  if (!definition.dotnetPath || !definition.envFilePath) {
    throw new ManagedPm2Error(
      `Released-service PM2 launch files are unavailable for ${definition.service}.`
    )
  }

  const args = [definition.script, ...definition.args]
  return [
    "module.exports = {",
    "  apps: [",
    "    {",
    `      name: ${JSON.stringify(definition.appName)},`,
    `      script: ${JSON.stringify(definition.dotnetPath)},`,
    `      args: ${JSON.stringify(args)},`,
    `      cwd: ${JSON.stringify(definition.cwd)},`,
    '      interpreter: "none",',
    '      exec_mode: "fork",',
    "      autorestart: true,",
    "      watch: false,",
    `      env_file: ${JSON.stringify(definition.envFilePath)}`,
    "    }",
    "  ]",
    "};",
    ""
  ].join("\n")
}

function buildPm2EnvFile(env: NodeJS.ProcessEnv): string {
  return (
    Object.entries(env)
      .filter(([key, value]) => key.trim().length > 0 && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, "\\n")}`)
      .join("\n") + "\n"
  )
}

function buildManagedPm2Environment(
  definition: ResolvedManagedPm2ServiceDefinition,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return buildManagedRuntimeEnvironment(
    {
      component: definition.component,
      manifest: { manifestDir: definition.manifestDir },
      paths: definition.paths,
      componentRoot: definition.componentRoot,
      componentConfigDir: definition.componentConfigDir,
      componentDataHome: definition.runtimeDataHome,
      pm2Home: definition.pm2Home,
      scriptBasename: basename(definition.script)
    },
    { ...baseEnv, ...definition.env }
  )
}

type ManagedPm2ParsedStatus =
  | {
      kind: "status"
      statusEntry: {
        status: ManagedPm2Status
        pid: number | null
      } | null
    }
  | {
      kind: "bootstrap"
      summary: string
    }
  | {
      kind: "failure"
      message: string
    }

function parseManagedPm2Status(
  result: CommandResult,
  appName: string
): ManagedPm2ParsedStatus {
  const trimmedStdout = result.stdout.trim()
  const trimmedStderr = result.stderr.trim()

  if (!trimmedStdout) {
    if (!trimmedStderr) {
      return {
        kind: "status",
        statusEntry: null
      }
    }

    if (isRetryablePm2BootstrapOutput(result.stdout, result.stderr)) {
      return {
        kind: "bootstrap",
        summary: summarizePm2Output(result)
      }
    }

    return {
      kind: "failure",
      message:
        "Managed PM2 status output was empty on stdout and could not be normalized from stderr."
    }
  }

  try {
    const parsed = parsePm2ProcessList(result)
    const entry = parsed.find((value) => isPm2ProcessRecord(value) && value.name === appName)

    if (!entry || !isPm2ProcessRecord(entry)) {
      return {
        kind: "status",
        statusEntry: null
      }
    }

    return {
      kind: "status",
      statusEntry: {
        status: normalizePm2Status(entry.pm2_env?.status),
        pid: typeof entry.pid === "number" ? entry.pid : null
      }
    }
  } catch (error) {
    if (isRetryablePm2BootstrapOutput(result.stdout, result.stderr)) {
      return {
        kind: "bootstrap",
        summary: summarizePm2Output(result)
      }
    }

    return {
      kind: "failure",
      message: `Managed PM2 status returned invalid JSON: ${error instanceof Error ? error.message : String(error)} (${summarizePm2Output(result)})`
    }
  }
}

function parsePm2ProcessList(result: CommandResult): unknown[] {
  const directCandidates = [result.stdout.trim(), `${result.stdout}\n${result.stderr}`.trim()].filter(
    Boolean
  )

  for (const candidate of directCandidates) {
    const direct = tryParseJson(candidate)
    if (Array.isArray(direct)) {
      return direct
    }

    const extracted = extractPm2JsonArray(candidate)
    if (Array.isArray(extracted)) {
      return extracted
    }
  }

  throw new Error("No JSON array payload was found in PM2 output.")
}

function extractPm2JsonArray(output: string): unknown[] | null {
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "[") {
      continue
    }

    const nextNonWhitespace = output.slice(index + 1).match(/\S/u)?.[0]
    if (nextNonWhitespace !== "{" && nextNonWhitespace !== "]") {
      continue
    }

    const parsed = tryParseJson(output.slice(index))
    if (Array.isArray(parsed)) {
      return parsed
    }
  }

  return null
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function summarizePm2Output(result: CommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 400)
}

function isRetryablePm2BootstrapOutput(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase()
  return [
    "[pm2] spawning",
    "[pm2] launching",
    "[pm2] starting",
    "[pm2] pm2 successfully daemonized",
    "spawning pm2 daemon",
    "pm2 home",
    "rpc socket",
    "pub socket",
    "daemon launched"
  ].some((marker) => combined.includes(marker))
}

function normalizePm2Status(value: unknown): ManagedPm2Status {
  switch (value) {
    case "online":
      return "online"
    case "stopped":
      return "stopped"
    case "errored":
      return "errored"
    default:
      return "unknown"
  }
}

function isPm2ProcessRecord(
  value: unknown
): value is {
  name?: string
  pid?: number
  pm2_env?: {
    status?: string
  }
} {
  return typeof value === "object" && value !== null
}

function defaultPm2Script(componentName: string): string {
  switch (componentName) {
    case "omniroute":
      return "current/omniroute-launcher.mjs"
    case "code-server":
      return "current/code-server-launcher.mjs"
    default:
      throw new ManagedPm2Error(`Unsupported PM2 component ${componentName}.`)
  }
}

function toPm2Args(args: readonly string[]): string[] {
  return args.length > 0 ? ["--", ...args] : []
}

function buildPm2ActionArgs(
  definition: ResolvedManagedPm2ServiceDefinition,
  action: "start" | "restart" | "stop" | "delete"
): string[] {
  if (definition.launchStrategy === "released-service") {
    if (!definition.ecosystemPath) {
      throw new ManagedPm2Error(
        `Released-service PM2 ecosystem file is unavailable for ${definition.service}.`
      )
    }

    switch (action) {
      case "start":
        return ["start", definition.ecosystemPath, "--only", definition.appName, "--update-env"]
      case "restart":
        return ["reload", definition.ecosystemPath, "--update-env"]
      case "stop":
        return ["stop", definition.appName]
      case "delete":
        return ["delete", definition.appName]
    }
  }

  switch (action) {
    case "start":
      if (isNodeLauncherScript(definition.script)) {
        return [
          "start",
          definition.script,
          "--name",
          definition.appName,
          "--cwd",
          definition.cwd,
          "--interpreter",
          definition.nodePath,
          "--update-env",
          ...toPm2Args(definition.args)
        ]
      }

      return [
        "start",
        definition.script,
        "--name",
        definition.appName,
        "--cwd",
        definition.cwd,
        "--update-env",
        ...toPm2Args(definition.args)
      ]
    case "restart":
      return ["restart", definition.appName, "--update-env"]
    case "stop":
      return ["stop", definition.appName]
    case "delete":
      return ["delete", definition.appName]
  }
}

function isNodeLauncherScript(scriptPath: string): boolean {
  const extension = extname(scriptPath).toLowerCase()
  return extension === ".js" || extension === ".mjs" || extension === ".cjs"
}

function getManagedPm2Entrypoint(npmPrefix: string): string {
  return process.platform === "win32"
    ? join(npmPrefix, "node_modules", "pm2", "bin", "pm2")
    : join(npmPrefix, "lib", "node_modules", "pm2", "bin", "pm2")
}

async function validateManagedPath(pathValue: string, message: string): Promise<void> {
  try {
    await access(pathValue)
  } catch (error) {
    throw new ManagedPm2Error(message, error instanceof Error ? { cause: error } : undefined)
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
