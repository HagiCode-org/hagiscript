import { spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { URL } from "node:url"
import { createGunzip } from "node:zlib"
import { pipeline } from "node:stream/promises"
import { extractZipArchive as extractZipArchiveWithNode } from "./zip-extract.mjs"

const PLACEHOLDER_PATTERN = /{{([A-Z0-9_]+)}}/g

export function readRuntimeScriptContext() {
  return {
    runtimeRoot: requiredEnv("HAGISCRIPT_RUNTIME_ROOT"),
    runtimeHome: requiredEnv("HAGICODE_RUNTIME_HOME"),
    runtimeDataHome: requiredEnv("HAGICODE_RUNTIME_DATA_HOME"),
    binDir: requiredEnv("HAGISCRIPT_RUNTIME_BIN_DIR"),
    configDir: requiredEnv("HAGISCRIPT_RUNTIME_CONFIG_DIR"),
    logsDir: requiredEnv("HAGISCRIPT_RUNTIME_LOGS_DIR"),
    dataDir: requiredEnv("HAGISCRIPT_RUNTIME_DATA_DIR"),
    statePath: requiredEnv("HAGISCRIPT_RUNTIME_STATE_PATH"),
    componentName: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_NAME"),
    componentType: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_TYPE"),
    componentRoot: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_ROOT"),
    componentConfigDir: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_CONFIG_DIR"),
    componentDataDir: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_DATA_DIR"),
    componentLogsDir: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_LOGS_DIR"),
    componentPm2Home: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_PM2_HOME"),
    runtimeNpmPrefix: requiredEnv("HAGISCRIPT_RUNTIME_NPM_PREFIX"),
    bundledInstallMode:
      process.env.HAGISCRIPT_RUNTIME_BUNDLED_INSTALL_MODE?.trim() || "extract",
    templateDir: process.env.HAGISCRIPT_RUNTIME_TEMPLATE_DIR?.trim() || null,
    componentVersion: process.env.HAGISCRIPT_RUNTIME_COMPONENT_VERSION?.trim() || null,
    npmRegistryMirror: process.env.HAGISCRIPT_RUNTIME_NPM_REGISTRY_MIRROR?.trim() || null,
    pm2VersionOverride: process.env.HAGISCRIPT_RUNTIME_PM2_VERSION_OVERRIDE?.trim() || null,
    vendoredRepository: process.env.HAGISCRIPT_RUNTIME_VENDORED_REPOSITORY?.trim() || "HagiCode-org/vendered",
    vendoredTag:
      process.env.HAGISCRIPT_RUNTIME_VENDORED_TAG?.trim() || "v2026.0526.0080",
    vendoredBaseUrl: process.env.HAGISCRIPT_RUNTIME_VENDORED_BASE_URL?.trim() || "https://github.com",
    downloadCacheEnabled: process.env.HAGISCRIPT_DOWNLOAD_CACHE !== "0",
    downloadCacheDir:
      process.env.HAGISCRIPT_DOWNLOAD_CACHE_DIR?.trim() ||
      path.join(homedir(), ".hagiscript", "download-cache"),
    phase: process.env.HAGISCRIPT_RUNTIME_PHASE?.trim() || "install",
    purge: process.env.HAGISCRIPT_RUNTIME_PURGE === "1"
  }
}

export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true })
}

export async function writeJsonFile(filePath, value) {
  await ensureDirectory(path.dirname(filePath))
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function writeComponentMarker(context, extra = {}) {
  const markerPath = path.join(context.componentRoot, ".hagicode-runtime.json")
  await writeJsonFile(markerPath, {
    component: context.componentName,
    type: context.componentType,
    version: context.componentVersion,
    phase: context.phase,
    runtimeRoot: context.runtimeRoot,
    generatedAt: new Date().toISOString(),
    ...extra
  })
  return markerPath
}

export async function materializeTemplate(templateName, destinationPath, variables, templateDir) {
  const resolvedTemplateDir = templateDir || readRuntimeScriptContext().templateDir
  if (!resolvedTemplateDir) {
    throw new Error(`No template directory configured for ${templateName}`)
  }

  const templatePath = path.join(resolvedTemplateDir, templateName)
  const template = await readFile(templatePath, "utf8")
  const rendered = renderConfigTemplate(template, variables)

  await ensureDirectory(path.dirname(destinationPath))
  await writeFile(destinationPath, rendered, "utf8")
  return destinationPath
}

export function renderConfigTemplate(template, values) {
  const rendered = String(template).replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Missing template variable ${key}`)
    }

    return String(values[key])
  })

  const unresolved = rendered.match(PLACEHOLDER_PATTERN)
  if (unresolved) {
    throw new Error(`Unresolved template variables remain: ${unresolved.join(", ")}`)
  }

  return rendered.endsWith("\n") ? rendered : `${rendered}\n`
}

export function quoteYamlString(value) {
  return JSON.stringify(String(value))
}

export async function writeNodeEntrypoint(filePath, message) {
  await ensureDirectory(path.dirname(filePath))
  await writeFile(
    filePath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(message)} + "\\n")\n`,
    "utf8"
  )
  await makeExecutable(filePath)
  return filePath
}

export async function writeCommandWrapper(binDir, commandName, scriptPath, options = {}) {
  await ensureDirectory(binDir)
  const baseArgs = Array.isArray(options.baseArgs) ? options.baseArgs.map((entry) => String(entry)) : []
  const extension = path.extname(scriptPath).toLowerCase()
  const nodeWrapperPath = path.join(binDir, process.platform === "win32" ? "node.cmd" : "node")

  if (process.platform === "win32") {
    const wrapperPath = path.join(binDir, `${commandName}.cmd`)
    const relativeTarget = path.relative(path.dirname(wrapperPath), scriptPath).replaceAll("/", "\\")
    const renderedBaseArgs = renderWindowsWrapperArgs(baseArgs)

    if (isNodeScriptExtension(extension)) {
      const relativeNode = path.relative(path.dirname(wrapperPath), nodeWrapperPath).replaceAll("/", "\\")
      await writeFile(
        wrapperPath,
        `@echo off\r\nset "HAGISCRIPT_NODE=%~dp0\\${relativeNode}"\r\nif exist "%HAGISCRIPT_NODE%" (\r\n  "%HAGISCRIPT_NODE%" "%~dp0\\${relativeTarget}"${renderedBaseArgs} %*\r\n) else (\r\n  node "%~dp0\\${relativeTarget}"${renderedBaseArgs} %*\r\n)\r\n`,
        "utf8"
      )
      return wrapperPath
    }

    const invokeTarget = isWindowsBatchExtension(extension)
      ? `call "%~dp0\\${relativeTarget}"`
      : `"%~dp0\\${relativeTarget}"`
    await writeFile(
      wrapperPath,
      `@echo off\r\n${invokeTarget}${renderedBaseArgs} %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8"
    )
    return wrapperPath
  }

  const wrapperPath = path.join(binDir, commandName)
  const relativeTarget = path.relative(path.dirname(wrapperPath), scriptPath).replaceAll("\\", "/")
  const renderedBaseArgs = renderShellWrapperArgs(baseArgs)
  const targetPathExpression = `"$(dirname "$0")/${relativeTarget}"`

  if (isNodeScriptExtension(extension)) {
    const relativeNode = path.relative(path.dirname(wrapperPath), nodeWrapperPath).replaceAll("\\", "/")
    await writeFile(
      wrapperPath,
      `#!/usr/bin/env sh
node_cmd="$(dirname "$0")/${relativeNode}"
if [ -x "$node_cmd" ]; then
  exec "$node_cmd" ${targetPathExpression}${renderedBaseArgs} "$@"
fi
exec node ${targetPathExpression}${renderedBaseArgs} "$@"
`,
      "utf8"
    )
  } else {
    const launchCommand = shouldInvokeWithShell(extension)
      ? `exec sh ${targetPathExpression}${renderedBaseArgs} "$@"`
      : `exec ${targetPathExpression}${renderedBaseArgs} "$@"`
    await writeFile(
      wrapperPath,
      `#!/usr/bin/env sh
${launchCommand}
`,
      "utf8"
    )
  }
  await makeExecutable(wrapperPath)
  return wrapperPath
}

export async function installVendoredPackage(context, options) {
  const { repository, baseUrl } = parseGitHubRepositoryConfig(
    context.vendoredRepository,
    context.vendoredBaseUrl
  )
  const platform = normalizeVendoredPlatform(process.platform)
  const arch = normalizeVendoredArchitecture(process.arch)
  const installMode = options.installMode || context.bundledInstallMode || "extract"
  const archiveFormat = resolveVendoredArchiveFormat(platform, installMode)
  const preferredSource = createVendoredAssetSource({
    repository,
    baseUrl,
    releaseTag: context.vendoredTag,
    packageName: options.packageName,
    platform,
    arch,
    archiveFormat,
    downloadCacheDir: context.downloadCacheDir
  })

  if (installMode === "archive-7z-only") {
    const archivePath =
      options.archivePath || path.join(path.dirname(options.prefixRoot), "archives", preferredSource.assetName)
    let resolvedSource = preferredSource
    let archiveCachePath = path.join(resolvedSource.cacheRoot, resolvedSource.assetName)

    if (context.downloadCacheEnabled) {
      const restoredArchivePath = await restoreVendoredArchiveFromCache(
        archiveCachePath,
        archivePath
      )
      if (restoredArchivePath) {
        return buildVendoredInstallResult(resolvedSource, {
          installMode,
          archivePath: restoredArchivePath,
          archiveFormat
        })
      }
    }

    await ensureDirectory(path.dirname(archivePath))

    try {
      await downloadVendoredAsset(resolvedSource.assetUrl, archivePath)
    } catch (error) {
      const fallbackSource = await resolveFallbackVendoredAssetSource(
        preferredSource,
        error
      )

      if (!fallbackSource) {
        throw error
      }

      resolvedSource = fallbackSource
      archiveCachePath = path.join(resolvedSource.cacheRoot, resolvedSource.assetName)

      if (context.downloadCacheEnabled) {
        const restoredArchivePath = await restoreVendoredArchiveFromCache(
          archiveCachePath,
          archivePath
        )
        if (restoredArchivePath) {
          return buildVendoredInstallResult(resolvedSource, {
            installMode,
            archivePath: restoredArchivePath,
            archiveFormat
          })
        }
      }

      await downloadVendoredAsset(resolvedSource.assetUrl, archivePath)
    }

    if (context.downloadCacheEnabled) {
      await storeFileInCache(archivePath, archiveCachePath)
    }

    return buildVendoredInstallResult(resolvedSource, {
      installMode,
      archivePath,
      archiveFormat
    })
  }

  if (context.downloadCacheEnabled) {
    const restoredEntrypoint = await restoreVendoredPackageFromCache(
      preferredSource.cacheRoot,
      options.prefixRoot,
      options.entrypointRelativePath
    )
    if (restoredEntrypoint) {
      return buildVendoredInstallResult(preferredSource, {
        installMode,
        entrypointPath: restoredEntrypoint,
        archiveFormat
      })
    }
  }

  const stagingRoot = await mkdtemp(path.join(tmpdir(), `hagiscript-vendored-${options.packageName}-`))

  try {
    const extractRoot = path.join(stagingRoot, "extract")
    let resolvedSource = preferredSource
    let extractedRoot

    try {
      extractedRoot = await downloadAndExtractVendoredPackage(
        resolvedSource,
        stagingRoot,
        extractRoot
      )
    } catch (error) {
      const fallbackSource = await resolveFallbackVendoredAssetSource(
        preferredSource,
        error
      )

      if (!fallbackSource) {
        throw error
      }

      resolvedSource = fallbackSource

      if (context.downloadCacheEnabled) {
        const restoredEntrypoint = await restoreVendoredPackageFromCache(
          resolvedSource.cacheRoot,
          options.prefixRoot,
          options.entrypointRelativePath
        )
        if (restoredEntrypoint) {
          return buildVendoredInstallResult(resolvedSource, {
            installMode,
            entrypointPath: restoredEntrypoint,
            archiveFormat
          })
        }
      }

      extractedRoot = await downloadAndExtractVendoredPackage(
        resolvedSource,
        stagingRoot,
        extractRoot
      )
    }

    await replaceDirectory(extractedRoot, options.prefixRoot)
    if (context.downloadCacheEnabled) {
      await storeDirectoryInCache(options.prefixRoot, resolvedSource.cacheRoot)
    }

    const entrypointPath = path.join(options.prefixRoot, options.entrypointRelativePath)
    await access(entrypointPath)

    return buildVendoredInstallResult(resolvedSource, {
      installMode,
      entrypointPath,
      archiveFormat
    })
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

export async function writeManagedPackageLauncher(filePath, options) {
  await ensureDirectory(path.dirname(filePath))

  await writeFile(
    filePath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process"

const entrypointPath = ${JSON.stringify(options.entrypointPath)}
const baseArgs = ${JSON.stringify(options.baseArgs ?? [])}
const baseEnv = ${JSON.stringify(options.defaultEnv ?? {})}
const child = spawn(
  process.execPath,
  [entrypointPath, ...baseArgs, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...baseEnv
    }
  }
)

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal)
  }
}

process.on("SIGINT", () => forwardSignal("SIGINT"))
process.on("SIGTERM", () => forwardSignal("SIGTERM"))

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})

child.on("error", (error) => {
  process.stderr.write(String(error?.stack ?? error) + "\\n")
  process.exit(1)
})
`,
    "utf8"
  )
  await makeExecutable(filePath)
  return filePath
}

function isNodeScriptExtension(extension) {
  return extension === ".js" || extension === ".mjs" || extension === ".cjs"
}

function isWindowsBatchExtension(extension) {
  return extension === ".cmd" || extension === ".bat"
}

function shouldInvokeWithShell(extension) {
  return extension === "" || extension === ".sh"
}

function renderShellWrapperArgs(args) {
  if (args.length === 0) {
    return ""
  }

  return ` ${args.map((entry) => JSON.stringify(entry)).join(" ")}`
}

function renderWindowsWrapperArgs(args) {
  if (args.length === 0) {
    return ""
  }

  return ` ${args.map((entry) => `"${String(entry).replaceAll('"', '""')}"`).join(" ")}`
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Missing runtime script environment variable: ${name}`)
  }

  return value
}

async function makeExecutable(filePath) {
  if (process.platform === "win32") {
    return
  }

  await chmod(filePath, 0o755)
}

export function runManagedCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(
        new Error(
          `Managed command failed: ${command} ${args.join(" ")} (code=${code ?? "null"}, signal=${signal ?? "null"})\n${stderr || stdout}`.trim()
        )
      )
    })
  })
}

function parseGitHubRepositoryConfig(repositoryValue, baseUrlValue) {
  const trimmedRepository = String(repositoryValue || "").trim()
  const repository =
    trimmedRepository.startsWith("https://github.com/")
      ? trimmedRepository
          .replace(/^https:\/\/github\.com\//u, "")
          .replace(/\.git$/u, "")
          .replace(/\/+$/u, "")
      : trimmedRepository

  if (!/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error(`Invalid vendored GitHub repository: ${trimmedRepository}`)
  }

  return {
    repository,
    baseUrl: String(baseUrlValue || "https://github.com").replace(/\/+$/u, "")
  }
}

function buildVendoredAssetName(options) {
  const releaseVersion = normalizeVendoredReleaseVersion(options.releaseTag)
  return `${options.packageName}-${releaseVersion}-${options.platform}-${options.arch}${getVendoredArchiveExtension(options.archiveFormat)}`
}

function buildVendoredAssetUrl(baseUrl, repository, releaseTag, assetName) {
  return `${baseUrl}/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`
}

function buildVendoredReleaseUrl(baseUrl, repository, releaseTag) {
  return `${baseUrl}/${repository}/releases/tag/${encodeURIComponent(releaseTag)}`
}

function createVendoredAssetSource(options) {
  const assetName = buildVendoredAssetName({
    packageName: options.packageName,
    releaseTag: options.releaseTag,
    platform: options.platform,
    arch: options.arch,
    archiveFormat: options.archiveFormat
  })

  return {
    repository: options.repository,
    baseUrl: options.baseUrl,
    releaseTag: options.releaseTag,
    releaseName: options.releaseTag.replace(/^v/u, ""),
    releaseUrl: buildVendoredReleaseUrl(
      options.baseUrl,
      options.repository,
      options.releaseTag
    ),
    packageName: options.packageName,
    platform: options.platform,
    arch: options.arch,
    archiveFormat: options.archiveFormat,
    assetName,
    assetUrl: buildVendoredAssetUrl(
      options.baseUrl,
      options.repository,
      options.releaseTag,
      assetName
    ),
    downloadCacheDir: options.downloadCacheDir,
    cacheRoot: path.join(
      options.downloadCacheDir,
      "vendored",
      options.packageName,
      options.releaseTag,
      `${options.platform}-${options.arch}`
    )
  }
}

function buildVendoredInstallResult(source, extra = {}) {
  return {
    releaseRepository: source.repository,
    releaseTag: source.releaseTag,
    releaseName: source.releaseName,
    releaseUrl: source.releaseUrl,
    releaseAssetName: source.assetName,
    releaseAssetUrl: source.assetUrl,
    ...extra
  }
}

function normalizeVendoredReleaseVersion(releaseTag) {
  const normalized = String(releaseTag || "").trim().replace(/^v/u, "")
  if (!normalized) {
    throw new Error(`Invalid vendored release tag: ${String(releaseTag)}`)
  }

  return normalized
}

function normalizeVendoredPlatform(platform) {
  switch (platform) {
    case "darwin":
      return "macos"
    case "win32":
      return "windows"
    default:
      return "linux"
  }
}

function normalizeVendoredArchitecture(arch) {
  switch (String(arch).toLowerCase()) {
    case "x64":
      return "amd64"
    case "arm64":
    case "aarch64":
      return "arm64"
    default:
      throw new Error(`Unsupported vendored runtime architecture: ${arch}`)
  }
}

function resolveVendoredArchiveFormat(platform, installMode) {
  if (installMode === "archive-7z-only") {
    return "7z"
  }

  return platform === "windows" ? "zip" : "tar.gz"
}

function getVendoredArchiveExtension(archiveFormat) {
  switch (archiveFormat) {
    case "7z":
      return ".7z"
    case "zip":
      return ".zip"
    default:
      return ".tar.gz"
  }
}

async function downloadVendoredAsset(url, destinationPath) {
  const response = await globalThis.fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download vendored asset ${url}: HTTP ${response.status}`)
  }

  if (!response.body) {
    throw new Error(`Failed to download vendored asset ${url}: empty response body.`)
  }

  await ensureDirectory(path.dirname(destinationPath))
  const file = createWriteStream(destinationPath)

  const reader = response.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      if (!file.write(value)) {
        await new Promise((resolve) => file.once("drain", resolve))
      }
    }

    await new Promise((resolve, reject) =>
      file.end((error) => (error ? reject(error) : resolve()))
    )
  } finally {
    reader.releaseLock()
  }
}

async function downloadAndExtractVendoredPackage(source, stagingRoot, extractRoot) {
  const archivePath = path.join(stagingRoot, source.assetName)
  await downloadVendoredAsset(source.assetUrl, archivePath)
  return await extractVendoredArchive(
    archivePath,
    extractRoot,
    source.archiveFormat === "zip" ? "zip" : "tar.gz"
  )
}

async function resolveFallbackVendoredAssetSource(preferredSource, error) {
  if (!isVendoredAssetMissingError(error)) {
    return null
  }

  const releases = await listVendoredReleases(
    preferredSource.baseUrl,
    preferredSource.repository
  )

  for (const release of releases) {
    const releaseTag = typeof release?.tag_name === "string" ? release.tag_name.trim() : ""
    if (!releaseTag || releaseTag === preferredSource.releaseTag) {
      continue
    }

    const candidate = createVendoredAssetSource({
      repository: preferredSource.repository,
      baseUrl: preferredSource.baseUrl,
      releaseTag,
      packageName: preferredSource.packageName,
      platform: preferredSource.platform,
      arch: preferredSource.arch,
      archiveFormat: preferredSource.archiveFormat,
      downloadCacheDir: preferredSource.downloadCacheDir
    })
    const assetNames = Array.isArray(release.assets)
      ? new Set(
          release.assets
            .map((asset) => (typeof asset?.name === "string" ? asset.name : ""))
            .filter(Boolean)
        )
      : new Set()

    if (assetNames.has(candidate.assetName)) {
      return candidate
    }
  }

  return null
}

async function listVendoredReleases(baseUrl, repository) {
  const response = await globalThis.fetch(buildVendoredReleasesApiUrl(baseUrl, repository), {
    headers: buildVendoredReleaseApiHeaders()
  })

  if (!response.ok) {
    throw new Error(
      `Failed to query vendored releases for ${repository}: HTTP ${response.status}`
    )
  }

  const releases = await response.json()
  return Array.isArray(releases) ? releases : []
}

function buildVendoredReleasesApiUrl(baseUrl, repository) {
  const normalizedBaseUrl = String(baseUrl || "https://github.com").replace(/\/+$/u, "")

  try {
    const parsedUrl = new URL(normalizedBaseUrl)

    if (parsedUrl.hostname === "github.com") {
      return `https://api.github.com/repos/${repository}/releases?per_page=20`
    }

    if (parsedUrl.hostname === "api.github.com") {
      return `${normalizedBaseUrl}/repos/${repository}/releases?per_page=20`
    }
  } catch {
    // Fall through to the generic repository API path.
  }

  return `${normalizedBaseUrl}/repos/${repository}/releases?per_page=20`
}

function buildVendoredReleaseApiHeaders() {
  const token =
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.HAGISCRIPT_GITHUB_TOKEN?.trim()

  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "hagiscript-vendored-runtime",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

function isVendoredAssetMissingError(error) {
  return Boolean(
    error instanceof Error &&
      /Failed to download vendored asset .*: HTTP 404$/u.test(error.message.trim())
  )
}

async function extractVendoredArchive(archivePath, stagingDirectory, archiveKind) {
  await rm(stagingDirectory, { recursive: true, force: true })
  await mkdir(stagingDirectory, { recursive: true })

  if (archiveKind === "zip") {
    await extractZipArchive(archivePath, stagingDirectory)
  } else {
    await extractTarGzArchive(archivePath, stagingDirectory)
  }

  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory())

  if (directories.length !== 1) {
    throw new Error(
      `Expected exactly one extracted vendored root in ${stagingDirectory}, found ${directories.length}.`
    )
  }

  return path.join(stagingDirectory, directories[0].name)
}

async function extractZipArchive(archivePath, destination) {
  try {
    await extractZipArchiveWithNode(archivePath, destination)
  } catch (error) {
    const archiveError = error instanceof Error ? error : new Error(String(error))
    throw new Error(`Failed to extract vendored zip archive ${archivePath}: ${archiveError.message}`)
  }
}

async function extractTarGzArchive(archivePath, destination) {
  try {
    await runManagedCommand("tar", ["-xzf", archivePath, "-C", destination])
  } catch {
    await extractTarGzWithNode(archivePath, destination)
  }
}

async function extractTarGzWithNode(archivePath, destination) {
  const tarPath = `${archivePath}.tar`

  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      createWriteStream(tarPath)
    )
    await extractTarBuffer(await readFile(tarPath), destination)
  } finally {
    await rm(tarPath, { force: true }).catch(() => undefined)
  }
}

async function extractTarBuffer(buffer, destination) {
  let offset = 0

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      break
    }

    const name = header.toString("utf8", 0, 100).replace(/\0.*$/u, "")
    const sizeText = header
      .toString("utf8", 124, 136)
      .replace(/\0.*$/u, "")
      .trim()
    const typeFlag = header.toString("utf8", 156, 157)
    const size = parseInt(sizeText || "0", 8)
    const outputPath = safeArchiveJoin(destination, name)

    if (typeFlag === "5") {
      await mkdir(outputPath, { recursive: true })
    } else if (typeFlag === "0" || typeFlag === "") {
      await mkdir(path.dirname(outputPath), { recursive: true })
      await writeFile(outputPath, buffer.subarray(offset + 512, offset + 512 + size))
    }

    offset += 512 + Math.ceil(size / 512) * 512
  }
}

function safeArchiveJoin(root, entryName) {
  const normalized = path.join(root, entryName)
  const relativePath = path.relative(root, normalized)

  if (
    !entryName ||
    relativePath.startsWith("..") ||
    relativePath.includes(`${path.sep}..${path.sep}`) ||
    path.isAbsolute(entryName)
  ) {
    throw new Error(`Vendored archive entry escapes the extraction root: ${entryName}`)
  }

  return normalized
}

async function replaceDirectory(sourceDirectory, targetDirectory) {
  await rm(targetDirectory, { recursive: true, force: true })
  await ensureDirectory(path.dirname(targetDirectory))
  try {
    await rename(sourceDirectory, targetDirectory)
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error
    }

    await cp(sourceDirectory, targetDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true
    })
    await rm(sourceDirectory, { recursive: true, force: true })
  }
}

async function restoreVendoredPackageFromCache(cacheRoot, prefixRoot, entrypointRelativePath) {
  try {
    await stat(cacheRoot)
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }

    throw error
  }

  await rm(prefixRoot, { recursive: true, force: true })
  await ensureDirectory(path.dirname(prefixRoot))
  await cp(cacheRoot, prefixRoot, {
    recursive: true,
    force: false,
    errorOnExist: true
  })

  const entrypointPath = path.join(prefixRoot, entrypointRelativePath)
  try {
    await access(entrypointPath)
    return entrypointPath
  } catch (error) {
    await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined)
    await rm(prefixRoot, { recursive: true, force: true }).catch(() => undefined)
    if (isMissingPathError(error)) {
      return null
    }

    throw error
  }
}

async function storeDirectoryInCache(sourceDirectory, cacheDirectory) {
  try {
    await stat(cacheDirectory)
    return
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }
  }

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`
  await ensureDirectory(path.dirname(cacheDirectory))
  await cp(sourceDirectory, temporaryDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true
  })

  try {
    await rename(temporaryDirectory, cacheDirectory)
  } catch (error) {
    if (!isAlreadyCachedError(error)) {
      throw error
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function restoreVendoredArchiveFromCache(cachePath, destinationPath) {
  try {
    await stat(cachePath)
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }

    throw error
  }

  await ensureDirectory(path.dirname(destinationPath))
  await cp(cachePath, destinationPath, { force: true })
  await access(destinationPath)
  return destinationPath
}

async function storeFileInCache(sourcePath, cachePath) {
  try {
    await stat(cachePath)
    return
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }
  }

  const temporaryPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`
  await ensureDirectory(path.dirname(cachePath))
  await cp(sourcePath, temporaryPath, {
    force: false,
    errorOnExist: true
  })

  try {
    await rename(temporaryPath, cachePath)
  } catch (error) {
    if (!isAlreadyCachedError(error)) {
      throw error
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

function isMissingPathError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
  )
}

function isAlreadyCachedError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  )
}

function isCrossDeviceRenameError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EXDEV")
}
