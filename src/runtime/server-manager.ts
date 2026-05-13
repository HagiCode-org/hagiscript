import { cp, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import process from "node:process"
import semver from "semver"
import {
  copyFileFromCache,
  isDownloadCacheEnabled,
  resolveDownloadCacheDirectory,
  storeFileInCache
} from "./download-cache.js"
import { runCommand, type CommandRunner } from "./command-launch.js"
import {
  syncNpmGlobals,
  validateRegistryMirror,
  type NpmSyncSummary
} from "./npm-sync.js"
import {
  resolveManagedPm2Environment,
  runManagedPm2Command,
  type ManagedPm2Action,
  type ManagedPm2CommandResult,
  type ManagedPm2EnvironmentResult
} from "./pm2-manager.js"
import {
  loadRuntimeManifest,
  type RuntimeComponentDefinition
} from "./runtime-manifest.js"
import {
  getComponentManagedRoot,
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"
import {
  installRuntime,
  queryRuntimeState,
  type RuntimeLifecycleResult,
  type RuntimeStateReport
} from "./runtime-manager.js"

export type ManagedServerSourceKind =
  | "github-release"
  | "direct-url"
  | "local-archive"
  | "local-folder"

export interface ManagedServerInstallOptions {
  manifestPath?: string
  runtimeRoot?: string
  archivePath?: string
  packageDirectory?: string
  url?: string
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
  syncNpmGlobalsFn?: typeof syncNpmGlobals
}

export interface ManagedServerInstallResult {
  source: {
    kind: ManagedServerSourceKind
    locator: string
    version: string | null
    assetName: string
  }
  stagedPath: string
  stagedDllPath: string
  runtimeLifecycle: RuntimeLifecycleResult
  runtimeState: RuntimeStateReport
  pm2: {
    ensured: boolean
    versionRange: string | null
    summary?: NpmSyncSummary
  }
}

export interface ManagedServerLifecycleOptions {
  manifestPath?: string
  runtimeRoot?: string
  instanceName?: string
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

const DEFAULT_GITHUB_REPOSITORY = "HagiCode-org/releases"
const DEFAULT_GITHUB_TAG = "latest"
const DEFAULT_PM2_INSTANCE = "hagicode"

export async function installManagedServer(
  options: ManagedServerInstallOptions = {}
): Promise<ManagedServerInstallResult> {
  const logger = options.logger ?? (() => undefined)
  const runner = options.runner ?? runCommand
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })
  const serverComponent = assertServerComponent(manifest.componentMap.get("server"))
  const resolvedRegistryMirror = validateRegistryMirror(
    options.registryMirror,
    "registryMirror"
  )
  const archive = await resolveServerArchive(options, logger)

  try {
    const staged = await stageServerArchive({
      archivePath: archive.archivePath,
      paths,
      runner,
      serverComponent,
      extractArchive: options.extractArchive
    })

    const installRuntimeFn = options.installRuntimeFn ?? installRuntime
    const runtimeLifecycle = await installRuntimeFn({
      manifestPath: options.manifestPath,
      runtimeRoot: options.runtimeRoot,
      components: ["server"],
      force: options.force ?? false,
      downloadCache: options.downloadCache,
      downloadCacheDir: options.downloadCacheDir,
      logger
    })

    let pm2Summary: NpmSyncSummary | undefined
    if (options.ensurePm2 ?? true) {
      pm2Summary = await ensureManagedPm2({
        paths,
        pm2Version: options.pm2Version,
        registryMirror: resolvedRegistryMirror,
        force: options.force ?? false,
        logger,
        syncNpmGlobalsFn: options.syncNpmGlobalsFn
      })
    }

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
      stagedPath: staged.stagedPath,
      stagedDllPath: staged.stagedDllPath,
      runtimeLifecycle,
      runtimeState,
      pm2: {
        ensured: options.ensurePm2 ?? true,
        versionRange: options.ensurePm2 === false ? null : normalizePm2Version(options.pm2Version),
        summary: pm2Summary
      }
    }
  } finally {
    await archive.cleanup()
  }
}

export async function startManagedServer(
  options: ManagedServerLifecycleOptions = {}
): Promise<ManagedPm2CommandResult> {
  return runManagedServerAction("start", options)
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
  return resolveManagedPm2Environment({
    manifestPath: options.manifestPath,
    runtimeRoot: options.runtimeRoot,
    service: "server",
    nameIdentifierValue: options.instanceName?.trim() || DEFAULT_PM2_INSTANCE
  })
}

async function runManagedServerAction(
  action: ManagedPm2Action,
  options: ManagedServerLifecycleOptions
): Promise<ManagedPm2CommandResult> {
  return runManagedPm2Command({
    manifestPath: options.manifestPath,
    runtimeRoot: options.runtimeRoot,
    service: "server",
    action,
    nameIdentifierValue: options.instanceName?.trim() || DEFAULT_PM2_INSTANCE
  })
}

async function resolveServerArchive(
  options: ManagedServerInstallOptions,
  logger: (message: string) => void
): Promise<ResolvedServerArchive> {
  const selectedModes = [
    options.archivePath ? "archive" : null,
    options.packageDirectory ? "package-directory" : null,
    options.url ? "url" : null
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

  return resolveGitHubReleaseArchive(options)
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
    kind: "github-release" | "direct-url"
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

async function stageServerArchive(options: {
  archivePath: string
  paths: ResolvedRuntimePaths
  runner: CommandRunner
  serverComponent: RuntimeComponentDefinition
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
  const componentRoot = getComponentManagedRoot(options.paths, options.serverComponent.name)
  const targetCurrentRoot = join(componentRoot, "current")

  try {
    await (options.extractArchive ?? extractManagedServerArchive)(
      options.archivePath,
      extractRoot,
      options.runner
    )

    const payloadRoot = await locateManagedServerPayloadRoot(extractRoot)
    const stagedDllPath = join(targetCurrentRoot, "lib", "PCode.Web.dll")
    await mkdir(componentRoot, { recursive: true })
    await rm(targetCurrentRoot, { recursive: true, force: true })
    await cp(payloadRoot, targetCurrentRoot, {
      recursive: true,
      force: true
    })
    await assertValidManagedServerPayload(targetCurrentRoot)

    return {
      stagedPath: targetCurrentRoot,
      stagedDllPath
    }
  } finally {
    await rm(extractRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function ensureManagedPm2(options: {
  paths: ResolvedRuntimePaths
  pm2Version?: string
  registryMirror?: string
  force: boolean
  logger: (message: string) => void
  syncNpmGlobalsFn?: typeof syncNpmGlobals
}): Promise<NpmSyncSummary> {
  const syncNpmGlobalsFn = options.syncNpmGlobalsFn ?? syncNpmGlobals
  const tempDirectory = await mkdtemp(join(tmpdir(), "hagiscript-pm2-manifest-"))
  const manifestPath = join(tempDirectory, "manifest.json")
  const versionRange = normalizePm2Version(options.pm2Version)

  try {
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          packages: {
            pm2: {
              version: versionRange,
              ...(semver.valid(versionRange) ? { target: versionRange } : {})
            }
          }
        },
        null,
        2
      )}\n`
    )

    const summary = await syncNpmGlobalsFn({
      runtimePath: options.paths.nodeRuntime,
      manifestPath,
      registryMirror: options.registryMirror,
      force: options.force,
      npmOptions: {
        prefix: options.paths.npmPrefix
      },
      onLog: (event) => {
        if (event.type === "summary") {
          options.logger(
            `Managed pm2 ready in ${options.paths.npmPrefix} (${event.summary.changedCount} change(s))`
          )
        }
      }
    })

    return summary
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined)
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
