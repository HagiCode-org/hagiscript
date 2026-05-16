import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import process from "node:process"
import semver from "semver"
import { parse as parseYaml } from "yaml"
import {
  copyFileFromCache,
  isDownloadCacheEnabled,
  resolveDownloadCacheDirectory,
  storeFileInCache
} from "./download-cache.js"
import { runCommand, type CommandRunner } from "./command-launch.js"
import {
  resolveManagedPm2Environment,
  runManagedPm2Command,
  supportedPm2Services,
  type ManagedPm2Action,
  type ManagedPm2CommandResult,
  type ManagedPm2ServiceName,
  type ManagedPm2EnvironmentResult
} from "./pm2-manager.js"
import {
  loadRuntimeManifest,
  type RuntimeComponentDefinition
} from "./runtime-manifest.js"
import {
  getComponentConfigDirectory,
  getServerSharedDataRoot,
  getServerVersionRoot,
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"
import {
  ensureManagedPm2Package,
  installRuntime,
  queryRuntimeState,
  type RuntimeLifecycleResult,
  type RuntimeStateReport
} from "./runtime-manager.js"
import { getManagedServerConfig } from "./server-config.js"
import {
  listManagedServerVersions as listManagedServerVersionSummaries,
  readManagedServerVersionState,
  registerManagedServerVersion,
  removeManagedServerVersion as removeInstalledManagedServerVersion,
  resolveManagedServerVersionStateContext,
  setActiveManagedServerVersion,
  type ManagedServerVersionSummary
} from "./server-version-state.js"

export type ManagedServerSourceKind =
  | "github-release"
  | "http-index"
  | "direct-url"
  | "local-archive"
  | "local-folder"

export interface ManagedServerInstallOptions {
  manifestPath?: string
  runtimeRoot?: string
  archivePath?: string
  packageDirectory?: string
  url?: string
  indexUrl?: string
  indexChannel?: string
  indexVersion?: string
  githubRepository?: string
  githubTag?: string
  assetName?: string
  force?: boolean
  ensurePm2?: boolean
  pm2Version?: string
  registryMirror?: string
  downloadCache?: boolean
  downloadCacheDir?: string
  githubToken?: string
  logger?: (message: string) => void
  fetchImpl?: typeof fetch
  runner?: CommandRunner
  extractArchive?: (
    archivePath: string,
    extractRoot: string,
    runner: CommandRunner
  ) => Promise<void>
  installRuntimeFn?: typeof installRuntime
  queryRuntimeStateFn?: typeof queryRuntimeState
}

export interface ManagedServerInstallResult {
  source: {
    kind: ManagedServerSourceKind
    locator: string
    version: string | null
    assetName: string
  }
  installedVersion: string
  activeVersion: string
  stagedPath: string
  stagedDllPath: string
  statePath: string
  sharedDataRoot: string
  runtimeLifecycle: RuntimeLifecycleResult
  runtimeState: RuntimeStateReport
  pm2: {
    ensured: boolean
    versionRange: string | null
  }
}

export interface ManagedServerLifecycleOptions {
  manifestPath?: string
  runtimeRoot?: string
  instanceName?: string
}

export interface ManagedServerEnvironmentResult {
  host: string
  port: number
  aspNetCoreUrls: string
  configPath: string
  sharedDataRoot: string
  environment: Record<string, string>
}

export interface ManagedServerVersionOptions {
  manifestPath?: string
  runtimeRoot?: string
}

export interface ManagedServerUseVersionOptions extends ManagedServerVersionOptions {
  version: string
}

export interface ManagedServerRemoveVersionOptions extends ManagedServerVersionOptions {
  version: string
}

export interface ManagedServerListResult {
  activeVersion: string | null
  versions: ManagedServerVersionSummary[]
  statePath: string
  sharedDataRoot: string
}

export interface ManagedServerUseVersionResult {
  previousActiveVersion: string | null
  activeVersion: string
  statePath: string
}

export interface ManagedServerRemoveVersionResult {
  activeVersion: string | null
  removedVersion: string
  removedPath: string
  statePath: string
}

export class ManagedServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ManagedServerError"
  }
}

interface ResolvedServerArchive {
  kind: ManagedServerSourceKind
  locator: string
  version: string | null
  assetName: string
  archivePath: string
  cleanup(): Promise<void>
}

interface HttpIndexAssetDownloadSource {
  kind?: unknown
  label?: unknown
  url?: unknown
  primary?: unknown
}

interface HttpIndexAssetEntry {
  name?: unknown
  url?: unknown
  directUrl?: unknown
  browser_download_url?: unknown
  browserDownloadUrl?: unknown
  downloadUrl?: unknown
  downloadSources?: unknown
  sources?: unknown
}

interface HttpIndexVersionEntry {
  version?: unknown
  tag?: unknown
  channel?: unknown
  channels?: unknown
  assets?: unknown
  files?: unknown
}

interface HttpIndexDocument {
  versions?: unknown
  assets?: unknown
}

interface NormalizedHttpIndexAsset {
  assetName: string
  downloadUrl: string
}

interface NormalizedHttpIndexVersion {
  version: string | null
  channels: Set<string>
  assets: NormalizedHttpIndexAsset[]
}

const DEFAULT_GITHUB_REPOSITORY = "HagiCode-org/releases"
const DEFAULT_GITHUB_TAG = "latest"
const DEFAULT_SERVER_HTTP_INDEX_URL = "https://index.hagicode.com/server/index.json"
const LEGACY_SERVER_HTTP_INDEX_URLS = new Set([
  "https://server.dl.hagicode.com/index.json"
])
const DEFAULT_CODE_SERVER_HOST = "127.0.0.1"
const DEFAULT_CODE_SERVER_PORT = 8080
const DEFAULT_CODE_SERVER_AUTH_MODE = "none"
const DEFAULT_OMNIROUTE_HOST = "127.0.0.1"
const DEFAULT_OMNIROUTE_PORT = 39001
const MANAGED_SERVER_INTEGRATION_DEPENDENCIES: readonly ManagedPm2ServiceName[] = [
  "code-server",
  "omniroute"
]
const VSCODE_SERVER_SOURCE_EXTERNAL = "external"
const VSCODE_SERVER_SECRET_SOURCE_BOOTSTRAP = "bootstrap"
const OMNIROUTE_SOURCE_EXTERNAL = "external"

export async function installManagedServer(
  options: ManagedServerInstallOptions = {}
): Promise<ManagedServerInstallResult> {
  const logger = options.logger ?? (() => undefined)
  const runner = options.runner ?? runCommand
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const resolvedInstallOptions = applyManifestServerInstallDefaults(manifest, options)
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const serverComponent = assertServerComponent(manifest.componentMap.get("server"))
  const archive = await resolveServerArchive(resolvedInstallOptions, logger)
  const installedVersion = resolveManagedServerVersion(archive)

  try {
    const staged = await stageServerArchive({
      archivePath: archive.archivePath,
      version: installedVersion,
      paths,
      runner,
      serverComponent,
      force: options.force ?? false,
      extractArchive: options.extractArchive
    })

    const installRuntimeFn = options.installRuntimeFn ?? installRuntime
    const runtimeDependencyComponents = [...serverComponent.lifecycleDependencies]
    const runtimeLifecycle = await installRuntimeFn({
      manifestPath: options.manifestPath,
      runtimeRoot: options.runtimeRoot,
      components: runtimeDependencyComponents,
      force: options.force ?? false,
      downloadCache: options.downloadCache,
      downloadCacheDir: options.downloadCacheDir,
      npmRegistryMirror: options.registryMirror,
      pm2VersionOverride: options.pm2Version,
      logger
    })

    if (options.ensurePm2 ?? true) {
      await ensureManagedPm2Package(manifest, paths, {
        npmRegistryMirror: options.registryMirror,
        pm2VersionOverride: options.pm2Version
      })
    }

    const versionStateContext = await resolveManagedServerVersionStateContext({
      manifestPath: options.manifestPath,
      runtimeRoot: options.runtimeRoot
    })
    const sharedDataRoot = getServerSharedDataRoot(versionStateContext.paths)
    await registerManagedServerVersion(versionStateContext.statePath, {
      version: installedVersion,
      installPath: staged.stagedPath,
      installedAt: new Date().toISOString(),
      source: {
        kind: archive.kind,
        locator: archive.locator,
        assetName: archive.assetName
      }
    })

    const queryRuntimeStateFn = options.queryRuntimeStateFn ?? queryRuntimeState
    const runtimeState = await queryRuntimeStateFn({
      manifestPath: options.manifestPath,
      runtimeRoot: options.runtimeRoot
    })

    return {
      source: {
        kind: archive.kind,
        locator: archive.locator,
        version: archive.version,
        assetName: archive.assetName
      },
      installedVersion,
      activeVersion: installedVersion,
      stagedPath: staged.stagedPath,
      stagedDllPath: staged.stagedDllPath,
      statePath: versionStateContext.statePath,
      sharedDataRoot,
      runtimeLifecycle,
      runtimeState,
      pm2: {
        ensured: options.ensurePm2 ?? true,
        versionRange: options.ensurePm2 === false ? null : normalizePm2Version(options.pm2Version)
      }
    }
  } finally {
    await archive.cleanup()
  }
}

function applyManifestServerInstallDefaults(
  manifest: Awaited<ReturnType<typeof loadRuntimeManifest>>,
  options: ManagedServerInstallOptions
): ManagedServerInstallOptions {
  if (
    options.archivePath ||
    options.packageDirectory ||
    options.url ||
    options.indexUrl ||
    options.indexChannel ||
    options.indexVersion
  ) {
    return options
  }

  const serverComponent = manifest.componentMap.get("server")
  const activeVersion = serverComponent?.releasedService?.activeVersion?.trim()
  if (!activeVersion) {
    return options
  }

  return {
    ...options,
    indexVersion: activeVersion
  }
}

export async function startManagedServer(
  options: ManagedServerLifecycleOptions = {}
): Promise<ManagedPm2CommandResult> {
  return runManagedServerAction("start", options)
}

export async function listManagedServerVersions(
  options: ManagedServerVersionOptions = {}
): Promise<ManagedServerListResult> {
  const context = await resolveManagedServerVersionStateContext(options)
  const state = await readManagedServerVersionState(context.statePath)

  return {
    activeVersion: state.activeVersion,
    versions: await listManagedServerVersionSummaries(context.statePath),
    statePath: context.statePath,
    sharedDataRoot: getServerSharedDataRoot(context.paths)
  }
}

export async function useManagedServerVersion(
  options: ManagedServerUseVersionOptions
): Promise<ManagedServerUseVersionResult> {
  const version = options.version.trim()
  if (!version) {
    throw new ManagedServerError("Managed server version must be a non-empty string.")
  }

  const context = await resolveManagedServerVersionStateContext(options)
  const state = await readManagedServerVersionState(context.statePath)
  const previousActiveVersion = state.activeVersion
  await setActiveManagedServerVersion(context.statePath, version)

  return {
    previousActiveVersion,
    activeVersion: version,
    statePath: context.statePath
  }
}

export async function removeManagedServerInstalledVersion(
  options: ManagedServerRemoveVersionOptions
): Promise<ManagedServerRemoveVersionResult> {
  const version = options.version.trim()
  if (!version) {
    throw new ManagedServerError("Managed server version must be a non-empty string.")
  }

  const context = await resolveManagedServerVersionStateContext(options)
  const state = await readManagedServerVersionState(context.statePath)
  const installedVersion = state.versions[version]
  if (!installedVersion) {
    throw new ManagedServerError(`Managed server version ${version} is not installed.`)
  }

  await rm(installedVersion.installPath, { recursive: true, force: true })
  const nextState = await removeInstalledManagedServerVersion(context.statePath, version)

  return {
    activeVersion: nextState.activeVersion,
    removedVersion: version,
    removedPath: installedVersion.installPath,
    statePath: context.statePath
  }
}

export async function restartManagedServer(
  options: ManagedServerLifecycleOptions = {}
): Promise<ManagedPm2CommandResult> {
  return runManagedServerAction("restart", options)
}

export async function stopManagedServer(
  options: ManagedServerLifecycleOptions = {}
): Promise<ManagedPm2CommandResult> {
  return runManagedServerAction("stop", options)
}

export async function getManagedServerStatus(
  options: ManagedServerLifecycleOptions = {}
): Promise<ManagedPm2CommandResult> {
  return runManagedServerAction("status", options)
}

export async function resolveManagedServerStartupEnvironment(
  options: ManagedServerLifecycleOptions = {}
): Promise<ManagedPm2EnvironmentResult> {
  const environmentOverrides = (await resolveManagedServerEnvironment(options)).environment
  return resolveManagedPm2Environment({
    manifestPath: options.manifestPath,
    runtimeRoot: options.runtimeRoot,
    service: "server",
    nameIdentifierValue: options.instanceName?.trim(),
    environmentOverrides
  })
}

async function runManagedServerAction(
  action: ManagedPm2Action,
  options: ManagedServerLifecycleOptions
): Promise<ManagedPm2CommandResult> {
  if (action === "start") {
    await ensureManagedServerDependenciesStarted(options)
  }

  const environmentOverrides = (await resolveManagedServerEnvironment(options)).environment
  return runManagedPm2Command({
    manifestPath: options.manifestPath,
    runtimeRoot: options.runtimeRoot,
    service: "server",
    action,
    nameIdentifierValue: options.instanceName?.trim(),
    environmentOverrides
  })
}

async function ensureManagedServerDependenciesStarted(
  options: ManagedServerLifecycleOptions
): Promise<void> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const managedPm2ServiceNames = new Set<string>(supportedPm2Services)
  const dependencyServices = MANAGED_SERVER_INTEGRATION_DEPENDENCIES.filter(
    (service) => service !== "server" && managedPm2ServiceNames.has(service) && manifest.componentMap.has(service)
  )

  for (const service of dependencyServices) {
    await runManagedPm2Command({
      manifestPath: options.manifestPath,
      runtimeRoot: options.runtimeRoot,
      service,
      action: "start",
      nameIdentifierValue: options.instanceName?.trim()
    })
  }
}

export async function resolveManagedServerEnvironment(
  options: ManagedServerLifecycleOptions
): Promise<ManagedServerEnvironmentResult> {
  const serverConfig = await getManagedServerConfig({
    manifestPath: options.manifestPath,
    runtimeRoot: options.runtimeRoot
  })
  const sharedDataRoot = dirname(dirname(serverConfig.configPath))
  const systemDataRoot = join(sharedDataRoot, "data")
  const integrationEnvironment = await resolveManagedServerIntegrationEnvironment(options)

  return {
    host: serverConfig.host,
    port: serverConfig.port,
    aspNetCoreUrls: serverConfig.aspNetCoreUrls,
    configPath: serverConfig.configPath,
    sharedDataRoot,
    environment: {
      ASPNETCORE_URLS: serverConfig.aspNetCoreUrls,
      Urls: serverConfig.aspNetCoreUrls,
      DATADIR: systemDataRoot,
      ...integrationEnvironment
    }
  }
}

async function resolveManagedServerIntegrationEnvironment(
  options: ManagedServerLifecycleOptions
): Promise<Record<string, string>> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })

  return {
    ...(await resolveManagedVsCodeServerEnvironment(manifest.componentMap.get("code-server"), paths)),
    ...(await resolveManagedOmniRouteEnvironment(manifest.componentMap.get("omniroute"), paths))
  }
}

async function resolveManagedVsCodeServerEnvironment(
  component: RuntimeComponentDefinition | undefined,
  paths: ResolvedRuntimePaths
): Promise<Record<string, string>> {
  if (!component) {
    return {}
  }

  const config = await readYamlObject(
    join(getComponentConfigDirectory(paths, component.name, component.runtimeDataDir), "config.yaml")
  )
  const address = parseConfiguredAddress(
    readConfigString(config, "bind-addr"),
    DEFAULT_CODE_SERVER_HOST,
    DEFAULT_CODE_SERVER_PORT
  )
  const authMode = readConfigString(config, "auth") ?? DEFAULT_CODE_SERVER_AUTH_MODE
  const secret = readConfigString(config, "password")

  return {
    VsCodeServer__Host: address.host,
    VsCodeServer__Port: String(address.port),
    VsCodeServer__AuthMode: authMode,
    VsCodeServer__Source: VSCODE_SERVER_SOURCE_EXTERNAL,
    VsCodeServer__SourceLocked: "true",
    ...(secret
      ? {
          VsCodeServer__Secret: secret,
          VsCodeServer__SecretSource: VSCODE_SERVER_SECRET_SOURCE_BOOTSTRAP
        }
      : {})
  }
}

async function resolveManagedOmniRouteEnvironment(
  component: RuntimeComponentDefinition | undefined,
  paths: ResolvedRuntimePaths
): Promise<Record<string, string>> {
  if (!component) {
    return {}
  }

  const config = await readYamlObject(
    join(getComponentConfigDirectory(paths, component.name, component.runtimeDataDir), "config.yaml")
  )
  const address = parseConfiguredAddress(
    readConfigString(config, "listen"),
    DEFAULT_OMNIROUTE_HOST,
    DEFAULT_OMNIROUTE_PORT
  )
  const baseUrl = buildHttpBaseUrl(address.host, address.port)

  return {
    OmniRoute__Enabled: "true",
    OmniRoute__ApiEndpoint: baseUrl,
    OmniRoute__DefaultBaseUrl: baseUrl,
    OmniRoute__DefaultBaseUrlSource: OMNIROUTE_SOURCE_EXTERNAL,
    OmniRoute__DefaultBaseUrlLocked: "true"
  }
}

async function readYamlObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(filePath, "utf8")
    const parsed = parseYaml(content)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseConfiguredAddress(
  value: string | undefined,
  defaultHost: string,
  defaultPort: number
): { host: string; port: number } {
  if (!value) {
    return { host: defaultHost, port: defaultPort }
  }

  try {
    const parsed = new URL(value.includes("://") ? value : `http://${value}`)
    const host = parsed.hostname || defaultHost
    const port = Number(parsed.port || String(defaultPort))

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { host: defaultHost, port: defaultPort }
    }

    return { host, port }
  } catch {
    return { host: defaultHost, port: defaultPort }
  }
}

function buildHttpBaseUrl(host: string, port: number): string {
  return new URL(`http://${host}:${port}`).toString()
}

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key]
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function resolveServerArchive(
  options: ManagedServerInstallOptions,
  logger: (message: string) => void
): Promise<ResolvedServerArchive> {
  const useHttpIndex =
    options.indexUrl !== undefined ||
    options.indexChannel !== undefined ||
    options.indexVersion !== undefined
  const selectedModes = [
    options.archivePath ? "archive" : null,
    options.packageDirectory ? "package-directory" : null,
    options.url ? "url" : null,
    useHttpIndex ? "index-url" : null
  ].filter(Boolean)

  if (selectedModes.length > 1) {
    throw new ManagedServerError(
      "Choose only one server package source: --archive, --package-dir, or --url."
    )
  }

  if (options.archivePath) {
    const archivePath = resolve(options.archivePath)
    await assertFileExists(archivePath, `Server archive not found: ${archivePath}`)
    logger(`Using local server archive ${archivePath}`)
    return {
      kind: "local-archive",
      locator: archivePath,
      version: null,
      assetName: basename(archivePath),
      archivePath,
      cleanup: async () => undefined
    }
  }

  if (options.packageDirectory) {
    const directory = resolve(options.packageDirectory)
    const selection = await selectServerArchiveFromDirectory(directory, options.assetName)
    logger(`Selected ${selection.assetName} from ${directory}`)
    return {
      kind: "local-folder",
      locator: directory,
      version: selection.version,
      assetName: selection.assetName,
      archivePath: selection.archivePath,
      cleanup: async () => undefined
    }
  }

  if (options.url) {
    return downloadRemoteArchive(
      {
        kind: "direct-url",
        locator: options.url,
        assetName: inferArchiveNameFromUrl(options.url),
        version: null,
        url: options.url
      },
      options
    )
  }

  if (useHttpIndex) {
    return resolveHttpIndexArchive(options)
  }

  try {
    return await resolveHttpIndexArchive(options)
  } catch (error) {
    logger(
      `Default HTTP index ${DEFAULT_SERVER_HTTP_INDEX_URL} unavailable. Falling back to GitHub release source.`
    )
    if (error instanceof ManagedServerError) {
      logger(`HTTP index resolution detail: ${error.message}`)
    }
  }

  return resolveGitHubReleaseArchive(options)
}

async function resolveHttpIndexArchive(
  options: ManagedServerInstallOptions
): Promise<ResolvedServerArchive> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") {
    throw new ManagedServerError("Global fetch is unavailable for HTTP index download.")
  }

  const indexUrl = normalizeOfficialServerHttpIndexUrl(options.indexUrl)

  const response = await fetchImpl(indexUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "@hagicode/hagiscript"
    }
  })

  if (!response.ok) {
    throw new ManagedServerError(
      `Failed to read HTTP index from ${indexUrl}: HTTP ${response.status}`
    )
  }

  const indexPayload = (await response.json()) as HttpIndexDocument
  const selection = selectArchiveFromHttpIndex(indexPayload, {
    indexUrl,
    channel: options.indexChannel,
    version: options.indexVersion,
    assetName: options.assetName
  })

  return downloadRemoteArchive(
    {
      kind: "http-index",
      locator: selection.locator,
      assetName: selection.assetName,
      version: selection.version,
      url: selection.downloadUrl
    },
    options
  )
}

function normalizeOfficialServerHttpIndexUrl(indexUrl?: string): string {
  const normalized = indexUrl?.trim() || DEFAULT_SERVER_HTTP_INDEX_URL

  return LEGACY_SERVER_HTTP_INDEX_URLS.has(normalized)
    ? DEFAULT_SERVER_HTTP_INDEX_URL
    : normalized
}

async function resolveGitHubReleaseArchive(
  options: ManagedServerInstallOptions
): Promise<ResolvedServerArchive> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") {
    throw new ManagedServerError("Global fetch is unavailable for GitHub release download.")
  }

  const repository = options.githubRepository?.trim() || DEFAULT_GITHUB_REPOSITORY
  const tag = options.githubTag?.trim() || DEFAULT_GITHUB_TAG
  const releaseEndpoint =
    tag === "latest"
      ? `https://api.github.com/repos/${repository}/releases/latest`
      : `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
  const response = await fetchImpl(releaseEndpoint, {
    headers: buildGitHubRequestHeaders(options.githubToken, "application/vnd.github+json")
  })

  if (!response.ok) {
    throw new ManagedServerError(
      `Failed to read GitHub release metadata from ${repository}: HTTP ${response.status}`
    )
  }

  const release = (await response.json()) as {
    tag_name?: string
    assets?: Array<{
      name?: string
      browser_download_url?: string
    }>
  }
  const desiredAssetName = options.assetName?.trim() || null
  const defaultSuffix = getDefaultManagedServerAssetSuffix()
  const asset = Array.isArray(release.assets)
    ? release.assets.find((entry) =>
        desiredAssetName
          ? entry?.name === desiredAssetName
          : typeof entry?.name === "string" && entry.name.endsWith(defaultSuffix)
      )
    : undefined

  if (!asset?.name || !asset.browser_download_url) {
    throw new ManagedServerError(
      desiredAssetName
        ? `GitHub release ${tag} in ${repository} does not expose asset ${desiredAssetName}.`
        : `GitHub release ${tag} in ${repository} does not expose an asset ending with ${defaultSuffix}.`
    )
  }

  return downloadRemoteArchive(
    {
      kind: "github-release",
      locator: `${repository}@${release.tag_name ?? tag}`,
      assetName: asset.name,
      version: release.tag_name ?? null,
      url: asset.browser_download_url
    },
    options
  )
}

async function downloadRemoteArchive(
  source: {
    kind: "github-release" | "direct-url" | "http-index"
    locator: string
    assetName: string
    version: string | null
    url: string
  },
  options: ManagedServerInstallOptions
): Promise<ResolvedServerArchive> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") {
    throw new ManagedServerError("Global fetch is unavailable for server download.")
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "hagiscript-server-download-"))
  const archivePath = join(tempDirectory, source.assetName)
  const cachePath = isDownloadCacheEnabled(options.downloadCache)
    ? join(
        resolveDownloadCacheDirectory(options.downloadCacheDir),
        "server",
        createHash("sha256").update(source.url).digest("hex"),
        source.assetName
      )
    : undefined

  try {
    const restoredSize = cachePath ? await copyFileFromCache(cachePath, archivePath) : undefined
    if (restoredSize === undefined) {
      const response = await fetchImpl(source.url, {
        headers: buildGitHubRequestHeaders(options.githubToken, "application/octet-stream")
      })
      if (!response.ok) {
        throw new ManagedServerError(
          `Failed to download ${source.url}: HTTP ${response.status}`
        )
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      await writeFile(archivePath, buffer)
      if (cachePath) {
        await storeFileInCache(archivePath, cachePath)
      }
    }

    return {
      kind: source.kind,
      locator: source.locator,
      version: source.version,
      assetName: source.assetName,
      archivePath,
      cleanup: async () => {
        await rm(tempDirectory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function selectArchiveFromHttpIndex(
  payload: HttpIndexDocument,
  options: {
    indexUrl: string
    channel?: string
    version?: string
    assetName?: string
  }
): {
  locator: string
  version: string | null
  assetName: string
  downloadUrl: string
} {
  const desiredVersion = options.version?.trim() || null
  const desiredChannel = options.channel?.trim() || null
  const desiredAssetName = options.assetName?.trim() || null
  const defaultSuffix = getDefaultManagedServerAssetSuffix()

  const versionEntries = asArray(payload.versions)
    .map((entry) => normalizeHttpIndexVersionEntry(entry))
    .filter((entry): entry is NormalizedHttpIndexVersion => entry !== null)

  const indexLevelAssets = asArray(payload.assets)
    .map((entry) => normalizeHttpIndexAssetEntry(entry))
    .filter((entry): entry is NormalizedHttpIndexAsset => entry !== null)

  const candidateVersions = versionEntries.filter((entry) => {
    if (desiredVersion && entry.version !== desiredVersion) {
      return false
    }

    if (desiredChannel && !entry.channels.has(desiredChannel)) {
      return false
    }

    return true
  })

  const orderedVersions = candidateVersions
    .slice()
    .sort((left, right) => compareVersionValues(left.version, right.version))

  for (const versionEntry of orderedVersions) {
    const match = selectHttpIndexAsset(versionEntry.assets, {
      desiredAssetName,
      defaultSuffix
    })
    if (match) {
      return {
        locator: `${options.indexUrl}@${versionEntry.version ?? "unknown"}`,
        version: versionEntry.version,
        assetName: match.assetName,
        downloadUrl: match.downloadUrl
      }
    }
  }

  if (!desiredVersion && !desiredChannel && indexLevelAssets.length > 0) {
    const match = selectHttpIndexAsset(indexLevelAssets, {
      desiredAssetName,
      defaultSuffix
    })
    if (match) {
      return {
        locator: `${options.indexUrl}@index`,
        version: null,
        assetName: match.assetName,
        downloadUrl: match.downloadUrl
      }
    }
  }

  const scope = [
    desiredVersion ? `version=${desiredVersion}` : null,
    desiredChannel ? `channel=${desiredChannel}` : null,
    desiredAssetName ? `asset=${desiredAssetName}` : null
  ]
    .filter(Boolean)
    .join(", ")

  throw new ManagedServerError(
    `HTTP index ${options.indexUrl} does not expose a matching server archive${scope ? ` (${scope})` : ""}.`
  )
}

function normalizeHttpIndexVersionEntry(value: unknown): NormalizedHttpIndexVersion | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const entry = value as HttpIndexVersionEntry
  const version = normalizeString(entry.version) ?? normalizeString(entry.tag) ?? null
  const channels = new Set<string>()

  const singleChannel = normalizeString(entry.channel)
  if (singleChannel) {
    channels.add(singleChannel)
  }

  for (const item of asArray(entry.channels)) {
    const normalized = normalizeString(item)
    if (normalized) {
      channels.add(normalized)
    }
  }

  const assets = [...asArray(entry.assets), ...asArray(entry.files)]
    .map((item) => normalizeHttpIndexAssetEntry(item))
    .filter((item): item is NormalizedHttpIndexAsset => item !== null)

  return {
    version,
    channels,
    assets
  }
}

function normalizeHttpIndexAssetEntry(value: unknown): NormalizedHttpIndexAsset | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const entry = value as HttpIndexAssetEntry
  const assetName = normalizeString(entry.name)
  const directUrl =
    normalizeString(entry.url) ??
    normalizeString(entry.directUrl) ??
    normalizeString(entry.downloadUrl) ??
    normalizeString(entry.browser_download_url) ??
    normalizeString(entry.browserDownloadUrl)

  if (assetName && directUrl) {
    return {
      assetName,
      downloadUrl: directUrl
    }
  }

  const sourceUrl = resolveHttpIndexDownloadSourceUrl(entry.downloadSources ?? entry.sources)
  if (!assetName || !sourceUrl) {
    return null
  }

  return {
    assetName,
    downloadUrl: sourceUrl
  }
}

function resolveHttpIndexDownloadSourceUrl(value: unknown): string | null {
  const sources = asArray(value)
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null
      }
      const source = entry as HttpIndexAssetDownloadSource
      const url = normalizeString(source.url)
      if (!url) {
        return null
      }

      return {
        url,
        primary: source.primary === true
      }
    })
    .filter((entry): entry is { url: string; primary: boolean } => !!entry)

  if (sources.length === 0) {
    return null
  }

  return sources.find((entry) => entry.primary)?.url ?? sources[0].url
}

function selectHttpIndexAsset(
  assets: NormalizedHttpIndexAsset[],
  options: {
    desiredAssetName: string | null
    defaultSuffix: string
  }
): NormalizedHttpIndexAsset | null {
  if (options.desiredAssetName) {
    return assets.find((entry) => entry.assetName === options.desiredAssetName) ?? null
  }

  return (
    assets.find((entry) => entry.assetName.endsWith(options.defaultSuffix)) ??
    assets[0] ??
    null
  )
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function compareVersionValues(left: string | null, right: string | null): number {
  if (left && right) {
    const normalizedLeft = normalizeSemverLike(left)
    const normalizedRight = normalizeSemverLike(right)

    if (normalizedLeft && normalizedRight) {
      return semver.rcompare(normalizedLeft, normalizedRight)
    }
  }

  if (left === right) {
    return 0
  }

  if (left === null) {
    return 1
  }

  if (right === null) {
    return -1
  }

  return right.localeCompare(left)
}

function normalizeSemverLike(value: string): string | null {
  const normalized = value.startsWith("v") ? value.slice(1) : value
  return semver.valid(normalized)
}

async function stageServerArchive(options: {
  archivePath: string
  version: string
  paths: ResolvedRuntimePaths
  runner: CommandRunner
  serverComponent: RuntimeComponentDefinition
  force: boolean
  extractArchive?: (
    archivePath: string,
    extractRoot: string,
    runner: CommandRunner
  ) => Promise<void>
}): Promise<{
  stagedPath: string
  stagedDllPath: string
}> {
  const extractRoot = await mkdtemp(join(tmpdir(), "hagiscript-server-extract-"))
  const targetVersionRoot = getServerVersionRoot(options.paths, options.version)

  try {
    await (options.extractArchive ?? extractManagedServerArchive)(
      options.archivePath,
      extractRoot,
      options.runner
    )

    const payloadRoot = await locateManagedServerPayloadRoot(extractRoot)
    const stagedDllPath = join(targetVersionRoot, "lib", "PCode.Web.dll")
    if ((await pathExists(targetVersionRoot)) && !options.force) {
      throw new ManagedServerError(
        `Managed server version ${options.version} is already installed at ${targetVersionRoot}. Use --force to replace it.`
      )
    }
    await mkdir(targetVersionRoot, { recursive: true })
    await rm(targetVersionRoot, { recursive: true, force: true })
    await cp(payloadRoot, targetVersionRoot, {
      recursive: true,
      force: true
    })
    await assertValidManagedServerPayload(targetVersionRoot)

    return {
      stagedPath: targetVersionRoot,
      stagedDllPath
    }
  } finally {
    await rm(extractRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function selectServerArchiveFromDirectory(
  directory: string,
  assetName?: string
): Promise<{
  archivePath: string
  assetName: string
  version: string | null
}> {
  const entries = await readdir(directory, { withFileTypes: true })
  const zipFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => entry.name)

  if (zipFiles.length === 0) {
    throw new ManagedServerError(`No .zip archives found in ${directory}.`)
  }

  const desiredAssetName = assetName?.trim() || null
  if (desiredAssetName) {
    const matched = zipFiles.find((entry) => entry === desiredAssetName)
    if (!matched) {
      throw new ManagedServerError(`Archive ${desiredAssetName} was not found in ${directory}.`)
    }

    return {
      archivePath: join(directory, matched),
      assetName: matched,
      version: extractVersionFromServerAssetName(matched)
    }
  }

  const suffix = getDefaultManagedServerAssetSuffix()
  const candidates = zipFiles
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => ({
      assetName: entry,
      archivePath: join(directory, entry),
      version: extractVersionFromServerAssetName(entry)
    }))
    .filter((entry) => entry.version && semver.valid(entry.version))
    .sort((left, right) =>
      semver.rcompare(String(left.version), String(right.version))
    )

  if (candidates.length === 0) {
    throw new ManagedServerError(
      `No server archive ending with ${suffix} was found in ${directory}.`
    )
  }

  return candidates[0]
}

async function extractManagedServerArchive(
  archivePath: string,
  extractRoot: string,
  runner: CommandRunner
): Promise<void> {
  if (process.platform === "win32") {
    await runner("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractRoot.replaceAll("'", "''")}' -Force`
    ])
    return
  }

  try {
    await runner("unzip", ["-q", archivePath, "-d", extractRoot])
  } catch (error) {
    await runner("bsdtar", ["-xf", archivePath, "-C", extractRoot], {
      maxBuffer: 10 * 1024 * 1024
    })
  }
}

async function locateManagedServerPayloadRoot(extractRoot: string): Promise<string> {
  const searchQueue = [extractRoot]

  while (searchQueue.length > 0) {
    const current = searchQueue.shift()
    if (!current) {
      continue
    }

    const dllPath = join(current, "lib", "PCode.Web.dll")
    if (await pathExists(dllPath)) {
      return current
    }

    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        searchQueue.push(join(current, entry.name))
      }
    }
  }

  throw new ManagedServerError(
    `Extracted server archive does not contain lib/PCode.Web.dll under ${extractRoot}.`
  )
}

async function assertValidManagedServerPayload(payloadRoot: string): Promise<void> {
  for (const relativePath of [
    "lib/PCode.Web.dll",
    "lib/PCode.Web.deps.json",
    "lib/PCode.Web.runtimeconfig.json"
  ]) {
    await assertFileExists(
      join(payloadRoot, relativePath),
      `Managed server payload is missing required file ${relativePath}.`
    )
  }
}

function assertServerComponent(
  component: RuntimeComponentDefinition | undefined
): RuntimeComponentDefinition {
  if (!component) {
    throw new ManagedServerError("Runtime manifest does not define a server component.")
  }

  if (component.type !== "released-service") {
    throw new ManagedServerError("Runtime manifest server component must be a released-service.")
  }

  return component
}

async function assertFileExists(pathValue: string, message: string): Promise<void> {
  const target = resolve(pathValue)
  try {
    const result = await stat(target)
    if (!result.isFile()) {
      throw new ManagedServerError(message)
    }
  } catch (error) {
    if (error instanceof ManagedServerError) {
      throw error
    }

    throw new ManagedServerError(message, error instanceof Error ? { cause: error } : undefined)
  }
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

function extractVersionFromServerAssetName(assetName: string): string | null {
  const suffix = getDefaultManagedServerAssetSuffix().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const match = new RegExp(`^hagicode-(.+)-${suffix}$`, "u").exec(assetName)
  return match?.[1] ?? null
}

function resolveManagedServerVersion(archive: ResolvedServerArchive): string {
  const detectedVersion = archive.version ?? extractVersionFromServerAssetName(archive.assetName)
  const normalizedSemver = detectedVersion ? normalizeSemverLike(detectedVersion) : null
  const normalizedVersion = normalizedSemver ?? detectedVersion?.trim() ?? ""

  if (!normalizedVersion) {
    throw new ManagedServerError(
      `Unable to determine a concrete server version from ${archive.assetName}. Use a versioned archive name such as hagicode-1.2.3-${getDefaultManagedServerAssetSuffix()}.`
    )
  }

  return normalizedVersion
}

function inferArchiveNameFromUrl(urlValue: string): string {
  try {
    const parsed = new URL(urlValue)
    const candidate = basename(parsed.pathname)
    return candidate || "hagicode-server.zip"
  } catch {
    return "hagicode-server.zip"
  }
}

function normalizePm2Version(pm2Version: string | undefined): string {
  const normalized = pm2Version?.trim()
  return normalized && normalized.length > 0 ? normalized : "*"
}

function getDefaultManagedServerAssetSuffix(): string {
  return `${getManagedServerPlatform()}-${getManagedServerArchitecture()}-nort.zip`
}

function getManagedServerPlatform(platform = process.platform): "linux" | "win" | "osx" {
  switch (platform) {
    case "linux":
      return "linux"
    case "win32":
      return "win"
    case "darwin":
      return "osx"
    default:
      throw new ManagedServerError(`Unsupported server package platform: ${platform}`)
  }
}

function getManagedServerArchitecture(arch = process.arch): "x64" | "arm64" {
  switch (arch) {
    case "x64":
      return "x64"
    case "arm64":
      return "arm64"
    default:
      throw new ManagedServerError(`Unsupported server package architecture: ${arch}`)
  }
}

function buildGitHubRequestHeaders(
  githubToken?: string,
  accept = "application/json"
): Record<string, string> {
  const token =
    githubToken?.trim() || process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()

  return {
    Accept: accept,
    "User-Agent": "@hagicode/hagiscript",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}
