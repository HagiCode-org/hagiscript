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
  getServerSharedDataRoot,
  resolveManagedPath,
  resolveReleasedServicePath,
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"
import {
  getManagedServerVersionStatePath,
  readManagedServerVersionState
} from "./server-version-state.js"

export const supportedPm2Services = ["server", "omniroute", "code-server"] as const

export type ManagedPm2ServiceName = (typeof supportedPm2Services)[number]
export type ManagedPm2Action = "start" | "stop" | "restart" | "status" | "delete"
export type ManagedPm2Status = "online" | "stopped" | "errored" | "missing" | "unknown"

export interface ManagedPm2CommandOptions {
  manifestPath?: string
  runtimeRoot?: string
  service: ManagedPm2ServiceName
  action: ManagedPm2Action
  nameIdentifierValue?: string
  environmentOverrides?: Record<string, string | undefined>
  runner?: CommandRunner
}

type ManagedPm2LaunchStrategy = "node-script" | "native-wrapper" | "released-service"

export interface ResolvedManagedPm2ServiceDefinition {
  service: ManagedPm2ServiceName
  component: RuntimeComponentDefinition
  manifestDir: string
  paths: ResolvedRuntimePaths
  baseAppName: string
  appName: string
  nameIdentifierEnv: string
  defaultNameIdentifier: string
  nameIdentifier: string
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
  baseAppName: string
  appName: string
  nameIdentifierEnv: string
  nameIdentifier: string
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
  baseAppName: string
  appName: string
  nameIdentifierEnv: string
  nameIdentifier: string
  bootstrapNameIdentifierValue: string
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
const PM2_NAME_IDENTIFIER_PATTERN = /^[a-z0-9_]+$/u
const PM2_NAME_IDENTIFIER_BOOTSTRAP_DEFAULT = "hagicode"
const DEFAULT_PM2_NAME_IDENTIFIER_ENV = "hagicode_instance"

export async function runManagedPm2Command(
  options: ManagedPm2CommandOptions
): Promise<ManagedPm2CommandResult> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const definition = await resolveManagedPm2ServiceDefinition(
    manifest,
    paths,
    options.service,
    options.nameIdentifierValue,
    options.environmentOverrides
  )
  const runner = options.runner ?? runCommand

  switch (options.action) {
    case "start":
      return recreateManagedPm2App(definition, "start", runner)
    case "restart":
      return recreateManagedPm2App(definition, "restart", runner)
    case "stop":
      await cleanupManagedPm2App(definition, runner)
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

async function recreateManagedPm2App(
  definition: ResolvedManagedPm2ServiceDefinition,
  action: "start" | "restart",
  runner: CommandRunner
): Promise<ManagedPm2CommandResult> {
  await cleanupManagedPm2App(definition, runner)
  if (definition.launchStrategy === "released-service") {
    await prepareReleasedServicePm2Files(definition)
  }
  await executePm2(definition, buildPm2ActionArgs(definition, "start"), runner)
  return readManagedPm2Status(definition, action, runner)
}

async function cleanupManagedPm2App(
  definition: ResolvedManagedPm2ServiceDefinition,
  runner: CommandRunner
): Promise<void> {
  await executePm2(definition, buildPm2ActionArgs(definition, "stop"), runner, {
    allowMissingProcess: true
  })
  await executePm2(definition, buildPm2ActionArgs(definition, "delete"), runner, {
    allowMissingProcess: true
  })
}

export async function resolveManagedPm2Environment(
  options: Omit<ManagedPm2CommandOptions, "action" | "runner">
): Promise<ManagedPm2EnvironmentResult> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const definition = await resolveManagedPm2ServiceDefinition(
    manifest,
    paths,
    options.service,
    options.nameIdentifierValue,
    options.environmentOverrides
  )
  const env = buildManagedPm2Environment(definition)

  return {
    service: definition.service,
    baseAppName: definition.baseAppName,
    appName: definition.appName,
    nameIdentifierEnv: definition.nameIdentifierEnv,
    nameIdentifier: definition.nameIdentifier,
    bootstrapNameIdentifierValue: definition.defaultNameIdentifier,
    cwd: definition.cwd,
    script: definition.script,
    args: [...definition.args],
    env,
    pathKey: process.platform === "win32" ? "Path" : "PATH",
    pathEntries: getManagedRuntimePathEntries(definition.paths, {
      includeRuntimeBin: definition.component.type !== "released-service"
    }),
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
  service: ManagedPm2ServiceName,
  nameIdentifierValue?: string,
  environmentOverrides?: Record<string, string | undefined>
): Promise<ResolvedManagedPm2ServiceDefinition> {
  assertSupportedPm2Service(service)

  const component = manifest.componentMap.get(service)
  if (!component) {
    throw new ManagedPm2Error(`Runtime manifest does not define the ${service} service.`)
  }

  const defaultComponentRoot = getComponentManagedRoot(paths, component.name)
  const defaultRuntimeDataHome = getComponentRuntimeDataHome(
    paths,
    component.name,
    component.runtimeDataDir
  )
  const defaultComponentConfigDir = getComponentConfigDirectory(
    paths,
    component.name,
    component.runtimeDataDir
  )
  const nodePath = getRuntimeExecutablePaths(paths.nodeRuntime).nodePath
  const pm2Entrypoint = getManagedPm2Entrypoint(paths.npmPrefix)
  const { baseAppName, nameIdentifierEnv, defaultNameIdentifier, nameIdentifier } = resolvePm2NameIdentifier(
    manifest,
    component,
    service,
    nameIdentifierValue
  )
  const defaultPm2Home = getComponentPm2Home(
    paths,
    component.name,
    component.runtimeDataDir,
    component.pm2?.pm2Home,
    baseAppName
  )

  await Promise.all([
    validateManagedPath(
      pm2Entrypoint,
      "Managed PM2 binary is missing from the configured runtime npm prefix. Install pm2 into that prefix before using `hagiscript pm2 ...`."
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

    const resolvedServerPaths =
      service === "server"
        ? await resolveManagedServerActivePaths(
            paths,
            baseAppName,
            component.pm2?.pm2Home
          )
        : {
            componentRoot: defaultComponentRoot,
            runtimeDataHome: defaultRuntimeDataHome,
            componentConfigDir: defaultComponentConfigDir,
            pm2Home: defaultPm2Home
          }

    const cwd = resolveReleasedServicePath(
      releasedService.workingDirectory,
      resolvedServerPaths.componentRoot
    )
    const script = resolveReleasedServicePath(
      releasedService.dllPath,
      resolvedServerPaths.componentRoot
    )
    const runtimeFilesDir = join(
      resolvedServerPaths.runtimeDataHome,
      releasedService.runtimeFilesDir ?? "pm2-runtime"
    )
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
      baseAppName,
      appName: `${baseAppName}-${nameIdentifier}`,
      nameIdentifierEnv,
      defaultNameIdentifier,
      nameIdentifier,
      cwd,
      script,
      args: component.pm2?.args ?? [],
      env: mergeManagedEnvironment(component.pm2?.env, environmentOverrides),
      runtimeHome: paths.runtimeHome,
      runtimeDataHome: resolvedServerPaths.runtimeDataHome,
      componentRoot: resolvedServerPaths.componentRoot,
      componentConfigDir: resolvedServerPaths.componentConfigDir,
      pm2Home: resolvedServerPaths.pm2Home,
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
    defaultComponentRoot
  )
  const cwd = resolveManagedPath(component.pm2?.cwd ?? ".", defaultComponentRoot)

  await Promise.all([
    validateManagedPath(script, `Managed runtime entrypoint for ${service} is missing.`),
    validateManagedPath(cwd, `Managed working directory for ${service} is missing.`)
  ])

  return {
    service,
    component,
    manifestDir: manifest.manifestDir,
    paths,
    baseAppName,
    appName: `${baseAppName}-${nameIdentifier}`,
    nameIdentifierEnv,
    defaultNameIdentifier,
    nameIdentifier,
    cwd,
    script,
    args: component.pm2?.args ?? defaultBundledRuntimePm2Args(component.name, defaultComponentConfigDir),
    env: mergeManagedEnvironment(component.pm2?.env, environmentOverrides),
    runtimeHome: paths.runtimeHome,
    runtimeDataHome: defaultRuntimeDataHome,
    componentRoot: defaultComponentRoot,
    componentConfigDir: defaultComponentConfigDir,
    pm2Home: defaultPm2Home,
    pm2Binary: pm2Entrypoint,
    nodePath,
    launchStrategy: resolveBundledRuntimeLaunchStrategy(script)
  }
}

async function resolveManagedServerActivePaths(
  paths: ResolvedRuntimePaths,
  serviceHomeName: string,
  pm2HomeOverride?: string
): Promise<{
  componentRoot: string
  runtimeDataHome: string
  componentConfigDir: string
  pm2Home: string
}> {
  const runtimeDataHome = getServerSharedDataRoot(paths)
  const state = await readManagedServerVersionState(getManagedServerVersionStatePath(paths))
  const activeVersion = state.activeVersion

  if (!activeVersion) {
    throw new ManagedPm2Error(
      "Managed server does not have an active version. Run `hagiscript server install` or `hagiscript server use <version>` first."
    )
  }

  const installedVersion = state.versions[activeVersion]
  if (!installedVersion) {
    throw new ManagedPm2Error(
      `Managed server active version ${activeVersion} is missing from the installed version inventory.`
    )
  }

  return {
    componentRoot: installedVersion.installPath,
    runtimeDataHome,
    componentConfigDir: join(runtimeDataHome, "config"),
    pm2Home: getComponentPm2Home(
      paths,
      "server",
      undefined,
      pm2HomeOverride,
      serviceHomeName
    )
  }
}

export function renderManagedPm2StatusText(result: ManagedPm2CommandResult): string {
  return [
    `Service: ${result.service}`,
    `Base app: ${result.baseAppName}`,
    `Action: ${result.action}`,
    `App: ${result.appName}`,
    `Name identifier env: ${result.nameIdentifierEnv}`,
    `Name identifier: ${result.nameIdentifier}`,
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
    `Base app: ${result.baseAppName}`,
    `App: ${result.appName}`,
    `Name identifier env: ${result.nameIdentifierEnv}`,
    `Name identifier: ${result.nameIdentifier}`,
    `Default instance: ${result.nameIdentifierEnv}=${result.bootstrapNameIdentifierValue}`,
    "Use --instance to override the manifest-defined runtime instance when needed.",
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
        baseAppName: definition.baseAppName,
        appName: definition.appName,
        nameIdentifierEnv: definition.nameIdentifierEnv,
        nameIdentifier: definition.nameIdentifier,
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
  await writeFile(definition.envFilePath, buildPm2EnvFile(definition, env), "utf8")
  await writeFile(
    definition.ecosystemPath,
    buildReleasedServiceEcosystemConfig(definition, env),
    "utf8"
  )
}

function buildReleasedServiceEcosystemConfig(
  definition: ResolvedManagedPm2ServiceDefinition,
  env: NodeJS.ProcessEnv
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
    `      env: ${serializePm2Environment(env)},`,
    `      env_file: ${JSON.stringify(definition.envFilePath)}`,
    "    }",
    "  ]",
    "};",
    ""
  ].join("\n")
}

function buildPm2EnvFile(
  definition: ResolvedManagedPm2ServiceDefinition,
  env: NodeJS.ProcessEnv
): string {
  return (
    [
      `# Default instance: ${definition.nameIdentifierEnv}=${definition.defaultNameIdentifier}`,
      `# Use --instance to override the manifest-defined runtime instance when needed.`,
      ...Object.entries(env)
        .filter(([key, value]) => key.trim().length > 0 && value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, "\\n")}`)
    ].join("\n") + "\n"
  )
}

function serializePm2Environment(env: NodeJS.ProcessEnv): string {
  const normalizedEntries = Object.entries(env)
    .filter(([key, value]) => key.trim().length > 0 && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

  return JSON.stringify(Object.fromEntries(normalizedEntries), null, 8)
}

function buildManagedPm2Environment(
  definition: ResolvedManagedPm2ServiceDefinition,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const resolvedBaseEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...definition.env,
    [definition.nameIdentifierEnv]: definition.nameIdentifier
  }

  if (
    definition.service === "server" &&
    !normalizeManagedEnvironmentValue(resolvedBaseEnv.ASPNETCORE_ENVIRONMENT)
  ) {
    resolvedBaseEnv.ASPNETCORE_ENVIRONMENT = "Production"
  }

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
    resolvedBaseEnv
  )
}

function mergeManagedEnvironment(
  baseEnvironment: Record<string, string> | undefined,
  overrides: Record<string, string | undefined> | undefined
): Record<string, string> {
  const merged: Record<string, string> = {
    ...(baseEnvironment ?? {})
  }

  if (!overrides) {
    return merged
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!key.trim()) {
      continue
    }

    if (value === undefined) {
      delete merged[key]
      continue
    }

    merged[key] = value
  }

  return merged
}

function normalizeManagedEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function resolvePm2NameIdentifier(
  manifest: LoadedRuntimeManifest,
  component: RuntimeComponentDefinition,
  service: ManagedPm2ServiceName,
  nameIdentifierValue?: string
): {
  baseAppName: string
  nameIdentifierEnv: string
  defaultNameIdentifier: string
  nameIdentifier: string
} {
  const nameIdentifierEnv = DEFAULT_PM2_NAME_IDENTIFIER_ENV

  const defaultNameIdentifier =
    manifest.runtime.hagicodeInstance?.trim() || PM2_NAME_IDENTIFIER_BOOTSTRAP_DEFAULT
  const nameIdentifier =
    nameIdentifierValue?.trim() ||
    manifest.runtime.hagicodeInstance?.trim() ||
    process.env[nameIdentifierEnv]?.trim()
  if (!nameIdentifier) {
    throw new ManagedPm2Error(
      `Managed PM2 service ${service} requires a runtime instance name. Set runtime.hagicodeInstance in the manifest, pass --instance, or set ${nameIdentifierEnv}.`
    )
  }

  if (!PM2_NAME_IDENTIFIER_PATTERN.test(nameIdentifier)) {
    throw new ManagedPm2Error(
      `Managed PM2 service ${service} requires ${nameIdentifierEnv} to use only lowercase letters, digits, and underscores. Received "${nameIdentifier}".`
    )
  }

  return {
    baseAppName: component.pm2?.appName ?? `hagicode-${component.name}`,
    nameIdentifierEnv,
    defaultNameIdentifier,
    nameIdentifier
  }
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
      return "current/bin/omniroute.mjs"
    case "code-server":
      return "current/out/node/entry.js"
    default:
      throw new ManagedPm2Error(`Unsupported PM2 component ${componentName}.`)
  }
}

function defaultBundledRuntimePm2Args(componentName: string, componentConfigDir: string): string[] {
  const configPath = join(componentConfigDir, "config.yaml")

  switch (componentName) {
    case "omniroute":
      return ["--config", configPath, "--no-open"]
    case "code-server":
      return ["--config", configPath]
    default:
      return []
  }
}

function toPm2Args(args: readonly string[]): string[] {
  return args.length > 0 ? ["--", ...args] : []
}

function buildPm2ActionArgs(
  definition: ResolvedManagedPm2ServiceDefinition,
  action: "start" | "stop" | "delete"
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

      if (definition.launchStrategy === "native-wrapper") {
        return buildNativeWrapperPm2StartArgs(definition)
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
    case "stop":
      return ["stop", definition.appName]
    case "delete":
      return ["delete", definition.appName]
  }
}

function buildNativeWrapperPm2StartArgs(
  definition: ResolvedManagedPm2ServiceDefinition
): string[] {
  if (process.platform === "win32" && isWindowsBatchScript(definition.script)) {
    const cmdExe = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
    return [
      "start",
      cmdExe,
      "--name",
      definition.appName,
      "--cwd",
      definition.cwd,
      "--interpreter",
      "none",
      "--update-env",
      ...toPm2Args(["/d", "/s", "/c", definition.script, ...definition.args])
    ]
  }

  return [
    "start",
    definition.script,
    "--name",
    definition.appName,
    "--cwd",
    definition.cwd,
    "--interpreter",
    "none",
    "--update-env",
    ...toPm2Args(definition.args)
  ]
}

function isNodeLauncherScript(scriptPath: string): boolean {
  const extension = extname(scriptPath).toLowerCase()
  return extension === ".js" || extension === ".mjs" || extension === ".cjs"
}

function isWindowsBatchScript(scriptPath: string): boolean {
  const extension = extname(scriptPath).toLowerCase()
  return extension === ".cmd" || extension === ".bat"
}

function resolveBundledRuntimeLaunchStrategy(scriptPath: string): ManagedPm2LaunchStrategy {
  return isNodeLauncherScript(scriptPath) ? "node-script" : "native-wrapper"
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
