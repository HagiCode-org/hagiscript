import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  getServerSharedDataRoot,
  resolveRuntimePaths
} from "./runtime-paths.js"
import { loadRuntimeManifest } from "./runtime-manifest.js"

const SERVER_CONFIG_FILE_NAME = "server-config.json"
const DEFAULT_SERVER_HOST = "127.0.0.1"
const DEFAULT_SERVER_PORT = 39150

interface PersistedManagedServerConfig {
  host?: unknown
  port?: unknown
  aspNetCoreUrls?: unknown
  updatedAt?: unknown
}

export interface ManagedServerConfigOptions {
  manifestPath?: string
  runtimeRoot?: string
}

export interface ManagedServerConfigUpdate {
  host?: string
  port?: number
}

export interface ManagedServerConfigResult {
  host: string
  port: number
  aspNetCoreUrls: string
  configPath: string
  source: "manifest-default" | "config-file"
}

export class ManagedServerConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ManagedServerConfigError"
  }
}

export async function getManagedServerConfig(
  options: ManagedServerConfigOptions = {}
): Promise<ManagedServerConfigResult> {
  const context = await resolveServerConfigContext(options)
  const persisted = await readPersistedConfig(context.configPath)
  if (!persisted) {
    return {
      ...context.defaults,
      configPath: context.configPath,
      source: "manifest-default"
    }
  }

  const host = normalizeHost(persisted.host)
  const port = normalizePort(persisted.port)
  const explicitUrl = normalizeAspNetCoreUrls(persisted.aspNetCoreUrls)

  return {
    host: host ?? context.defaults.host,
    port: port ?? context.defaults.port,
    aspNetCoreUrls:
      explicitUrl ??
      buildAspNetCoreUrls(host ?? context.defaults.host, port ?? context.defaults.port),
    configPath: context.configPath,
    source: "config-file"
  }
}

export async function setManagedServerConfig(
  update: ManagedServerConfigUpdate,
  options: ManagedServerConfigOptions = {}
): Promise<ManagedServerConfigResult> {
  const normalizedHost = update.host === undefined ? undefined : validateHost(update.host)
  const normalizedPort = update.port === undefined ? undefined : validatePort(update.port)

  if (normalizedHost === undefined && normalizedPort === undefined) {
    throw new ManagedServerConfigError(
      "Provide at least one update value: --host and/or --port."
    )
  }

  const current = await getManagedServerConfig(options)
  const nextHost = normalizedHost ?? current.host
  const nextPort = normalizedPort ?? current.port
  const next: ManagedServerConfigResult = {
    host: nextHost,
    port: nextPort,
    aspNetCoreUrls: buildAspNetCoreUrls(nextHost, nextPort),
    configPath: current.configPath,
    source: "config-file"
  }

  await mkdir(dirname(next.configPath), { recursive: true })
  await writeFile(
    next.configPath,
    JSON.stringify(
      {
        host: next.host,
        port: next.port,
        aspNetCoreUrls: next.aspNetCoreUrls,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n",
    "utf8"
  )

  return next
}

export function buildAspNetCoreUrls(host: string, port: number): string {
  const normalizedHost = validateHost(host)
  const normalizedPort = validatePort(port)
  return `http://${normalizedHost}:${normalizedPort}`
}

async function resolveServerConfigContext(options: ManagedServerConfigOptions): Promise<{
  configPath: string
  defaults: Pick<ManagedServerConfigResult, "host" | "port" | "aspNetCoreUrls">
}> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const serverComponent = manifest.componentMap.get("server")
  if (!serverComponent) {
    throw new ManagedServerConfigError(
      "Runtime manifest does not define a server component."
    )
  }

  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const configDir = join(getServerSharedDataRoot(paths), "config")
  const configPath = join(configDir, SERVER_CONFIG_FILE_NAME)
  const manifestUrls = serverComponent.pm2?.env?.ASPNETCORE_URLS
  const parsedManifestUrls = parseAspNetCoreUrl(manifestUrls)
  const host = parsedManifestUrls?.host ?? DEFAULT_SERVER_HOST
  const port = parsedManifestUrls?.port ?? DEFAULT_SERVER_PORT

  return {
    configPath,
    defaults: {
      host,
      port,
      aspNetCoreUrls: buildAspNetCoreUrls(host, port)
    }
  }
}

async function readPersistedConfig(
  configPath: string
): Promise<PersistedManagedServerConfig | undefined> {
  try {
    const content = await readFile(configPath, "utf8")
    const parsed = JSON.parse(content) as PersistedManagedServerConfig
    if (!parsed || typeof parsed !== "object") {
      throw new ManagedServerConfigError(
        `Managed server config must be a JSON object: ${configPath}`
      )
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined
    }

    if (error instanceof ManagedServerConfigError) {
      throw error
    }

    throw new ManagedServerConfigError(
      `Failed to read managed server config: ${configPath}`,
      error instanceof Error ? { cause: error } : undefined
    )
  }
}

function parseAspNetCoreUrl(value: unknown): { host: string; port: number } | undefined {
  const normalized = normalizeAspNetCoreUrls(value)
  if (!normalized) {
    return undefined
  }

  const firstEntry = normalized
    .split(";")
    .map((entry) => entry.trim())
    .find(Boolean)
  if (!firstEntry) {
    return undefined
  }

  const matched = /^https?:\/\/([^:/\s]+|\[[^\]]+\]):(\d+)$/u.exec(firstEntry)
  if (!matched) {
    return undefined
  }

  const host = normalizeHost(matched[1])
  const port = normalizePort(Number(matched[2]))
  if (!host || !port) {
    return undefined
  }

  return { host, port }
}

function normalizeAspNetCoreUrls(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function normalizeHost(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function validateHost(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new ManagedServerConfigError("Server host must be a non-empty string.")
  }

  if (/\s/u.test(normalized)) {
    throw new ManagedServerConfigError("Server host cannot contain whitespace.")
  }

  return normalized
}

function normalizePort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value
  }

  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }

  return undefined
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ManagedServerConfigError("Server port must be an integer between 1 and 65535.")
  }

  return value
}