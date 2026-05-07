import { access } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import process from "node:process"
import type { CommandRunner, CommandResult } from "./command-launch.js"
import { runCommand } from "./command-launch.js"
import {
  buildManagedRuntimeEnvironment,
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
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"

export const supportedPm2Services = ["omniroute", "code-server"] as const

export type ManagedPm2ServiceName = (typeof supportedPm2Services)[number]
export type ManagedPm2Action = "start" | "stop" | "status"
export type ManagedPm2Status = "online" | "stopped" | "errored" | "missing" | "unknown"

export interface ManagedPm2CommandOptions {
  manifestPath?: string
  runtimeRoot?: string
  service: ManagedPm2ServiceName
  action: ManagedPm2Action
  runner?: CommandRunner
}

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
}

export class ManagedPm2Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ManagedPm2Error"
  }
}

export async function runManagedPm2Command(
  options: ManagedPm2CommandOptions
): Promise<ManagedPm2CommandResult> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const definition = await resolveManagedPm2ServiceDefinition(manifest, paths, options.service)
  const runner = options.runner ?? runCommand

  switch (options.action) {
    case "start":
      await runPm2(definition, buildPm2StartArgs(definition), runner)
      return readManagedPm2Status(definition, "start", runner)
    case "stop":
      await runPm2(definition, ["stop", definition.appName], runner)
      return readManagedPm2Status(definition, "stop", runner)
    case "status":
      return readManagedPm2Status(definition, "status", runner)
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
  const script = resolveManagedPath(
    component.pm2?.script ?? defaultPm2Script(component.name),
    componentRoot
  )
  const cwd = resolveManagedPath(component.pm2?.cwd ?? ".", componentRoot)
  const nodePath = getRuntimeExecutablePaths(paths.nodeRuntime).nodePath
  const pm2Entrypoint = getManagedPm2Entrypoint(paths.npmPrefix)

  await Promise.all([
    validateManagedPath(script, `Managed launcher for ${service} is missing`),
    validateManagedPath(cwd, `Managed working directory for ${service} is missing`),
    validateManagedPath(pm2Entrypoint, "Managed PM2 binary is missing. Install the runtime npm-packages component first."),
    validateManagedPath(nodePath, "Managed Node runtime is missing. Install the runtime node component first.")
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
    nodePath
  }
}

export function renderManagedPm2StatusText(result: ManagedPm2CommandResult): string {
  return [
    `Service: ${result.service}`,
    `Action: ${result.action}`,
    `App: ${result.appName}`,
    `Status: ${result.status}`,
    `Runtime home: ${result.runtimeHome}`,
    `Runtime data home: ${result.runtimeDataHome}`,
    `PM2 home: ${result.pm2Home}`,
    `Script: ${result.script}`,
    `Working directory: ${result.cwd}`,
    `PM2 binary: ${result.pm2Binary}`,
    `PID: ${result.pid ?? "n/a"}`
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
  const result = await runPm2(definition, ["jlist"], runner)
  const statusEntry = parsePm2Status(result, definition.appName)

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
    exists: statusEntry !== null,
    status: statusEntry?.status ?? "missing",
    pid: statusEntry?.pid ?? null,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

async function runPm2(
  definition: ResolvedManagedPm2ServiceDefinition,
  args: string[],
  runner: CommandRunner
): Promise<CommandResult> {
  const env = buildManagedRuntimeEnvironment(
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
    { ...process.env, ...definition.env }
  )

  return runner(definition.nodePath, [definition.pm2Binary, ...args], {
    cwd: definition.cwd,
    env,
    maxBuffer: 10 * 1024 * 1024
  })
}

function parsePm2Status(
  result: CommandResult,
  appName: string
): {
  status: ManagedPm2Status
  pid: number | null
} | null {
  const parsed = parsePm2ProcessList(result)

  if (!Array.isArray(parsed)) {
    throw new ManagedPm2Error(`Managed PM2 status returned an unexpected payload for ${appName}.`)
  }

  const entry = parsed.find((value) =>
    isPm2ProcessRecord(value) && value.name === appName
  )

  if (!entry || !isPm2ProcessRecord(entry)) {
    return null
  }

  return {
    status: normalizePm2Status(entry.pm2_env?.status),
    pid: typeof entry.pid === "number" ? entry.pid : null
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

  throw new ManagedPm2Error(
    `Managed PM2 status returned invalid JSON: ${summarizePm2Output(result)}`
  )
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

function buildPm2StartArgs(definition: ResolvedManagedPm2ServiceDefinition): string[] {
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
