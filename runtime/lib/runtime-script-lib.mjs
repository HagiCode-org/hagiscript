import { spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { createGunzip } from "node:zlib"
import { pipeline } from "node:stream/promises"

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
    templateDir: requiredEnv("HAGISCRIPT_RUNTIME_TEMPLATE_DIR"),
    componentVersion: process.env.HAGISCRIPT_RUNTIME_COMPONENT_VERSION?.trim() || null,
    vendoredRepository: process.env.HAGISCRIPT_RUNTIME_VENDORED_REPOSITORY?.trim() || "HagiCode-org/vendered",
    vendoredTag:
      process.env.HAGISCRIPT_RUNTIME_VENDORED_TAG?.trim() || "v2026.0506.0029",
    vendoredBaseUrl: process.env.HAGISCRIPT_RUNTIME_VENDORED_BASE_URL?.trim() || "https://github.com",
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

export async function materializeTemplate(templateName, destinationPath, variables) {
  const templatePath = path.join(readRuntimeScriptContext().templateDir, templateName)
  const template = await readFile(templatePath, "utf8")
  let rendered = template

  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value))
  }

  await ensureDirectory(path.dirname(destinationPath))
  await writeFile(destinationPath, rendered, "utf8")
  return destinationPath
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

export async function writeCommandWrapper(binDir, commandName, scriptPath) {
  await ensureDirectory(binDir)
  const nodeWrapperPath = path.join(binDir, process.platform === "win32" ? "node.cmd" : "node")

  if (process.platform === "win32") {
    const wrapperPath = path.join(binDir, `${commandName}.cmd`)
    const relativeTarget = path.relative(path.dirname(wrapperPath), scriptPath).replaceAll("/", "\\")
    const relativeNode = path.relative(path.dirname(wrapperPath), nodeWrapperPath).replaceAll("/", "\\")
    await writeFile(
      wrapperPath,
      `@echo off\r\nset "HAGISCRIPT_NODE=%~dp0\\${relativeNode}"\r\nif exist "%HAGISCRIPT_NODE%" (\r\n  "%HAGISCRIPT_NODE%" "%~dp0\\${relativeTarget}" %*\r\n) else (\r\n  node "%~dp0\\${relativeTarget}" %*\r\n)\r\n`,
      "utf8"
    )
    return wrapperPath
  }

  const wrapperPath = path.join(binDir, commandName)
  const relativeTarget = path.relative(path.dirname(wrapperPath), scriptPath).replaceAll("\\", "/")
  const relativeNode = path.relative(path.dirname(wrapperPath), nodeWrapperPath).replaceAll("\\", "/")
  await writeFile(
    wrapperPath,
    `#!/usr/bin/env sh
node_cmd="$(dirname "$0")/${relativeNode}"
if [ -x "$node_cmd" ]; then
  exec "$node_cmd" "$(dirname "$0")/${relativeTarget}" "$@"
fi
exec node "$(dirname "$0")/${relativeTarget}" "$@"
`,
    "utf8"
  )
  await makeExecutable(wrapperPath)
  return wrapperPath
}

export async function installVendoredPackage(context, options) {
  const { repository, baseUrl } = parseGitHubRepositoryConfig(
    context.vendoredRepository,
    context.vendoredBaseUrl
  )
  const releaseTag = context.vendoredTag
  const platform = normalizeVendoredPlatform(process.platform)
  const arch = normalizeVendoredArchitecture(process.arch)
  const assetName = buildVendoredAssetName({
    packageName: options.packageName,
    releaseTag,
    platform,
    arch
  })
  const assetUrl = buildVendoredAssetUrl(baseUrl, repository, releaseTag, assetName)

  const stagingRoot = await mkdtemp(path.join(tmpdir(), `hagiscript-vendored-${options.packageName}-`))

  try {
    const archivePath = path.join(stagingRoot, assetName)
    const extractRoot = path.join(stagingRoot, "extract")
    await downloadVendoredAsset(assetUrl, archivePath)
    const extractedRoot = await extractVendoredArchive(
      archivePath,
      extractRoot,
      path.extname(assetName).toLowerCase() === ".zip" ? "zip" : "tar.gz"
    )
    await replaceDirectory(extractedRoot, options.prefixRoot)

    const entrypointPath = path.join(options.prefixRoot, options.entrypointRelativePath)
    await access(entrypointPath)

    return {
      entrypointPath,
      releaseRepository: repository,
      releaseTag,
      releaseName: releaseTag.replace(/^v/u, ""),
      releaseUrl: `${baseUrl}/${repository}/releases/tag/${encodeURIComponent(releaseTag)}`,
      releaseAssetName: assetName,
      releaseAssetUrl: assetUrl
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

export async function writeManagedPackageLauncher(filePath, options) {
  await ensureDirectory(path.dirname(filePath))
  const configLoader =
    options.serviceKind === "omniroute"
      ? `
const runtimeConfig = await loadOmnirouteConfig()
const runtimeEnv = {
  ...(runtimeConfig.dataDir ? { DATA_DIR: runtimeConfig.dataDir } : {}),
  ...(runtimeConfig.logDir ? { LOG_DIR: runtimeConfig.logDir } : {}),
  ...(runtimeConfig.port ? { PORT: runtimeConfig.port } : {})
}
`
      : ""
  const configHelpers =
    options.serviceKind === "omniroute"
      ? `
async function loadOmnirouteConfig() {
  try {
    const [{ readFile }, { parse }] = await Promise.all([
      import("node:fs/promises"),
      import("yaml")
    ])
    const loaded = parse(await readFile(configPath, "utf8"))
    const listen = typeof loaded?.listen === "string" ? loaded.listen : ""
    const portMatch = listen.match(/:(\\d+)$/u)
    return {
      dataDir: typeof loaded?.dataDir === "string" ? loaded.dataDir : ${JSON.stringify(
          options.defaultEnv?.DATA_DIR ?? ""
        )},
      logDir: typeof loaded?.logDir === "string" ? loaded.logDir : ${JSON.stringify(
          options.defaultEnv?.LOG_DIR ?? ""
        )},
      port: portMatch?.[1] ?? ${JSON.stringify(options.defaultEnv?.PORT ?? "")}
    }
  } catch {
    return {
      dataDir: ${JSON.stringify(options.defaultEnv?.DATA_DIR ?? "")},
      logDir: ${JSON.stringify(options.defaultEnv?.LOG_DIR ?? "")},
      port: ${JSON.stringify(options.defaultEnv?.PORT ?? "")}
    }
  }
}
`
      : ""

  await writeFile(
    filePath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process"

const entrypointPath = ${JSON.stringify(options.entrypointPath)}
const configPath = ${JSON.stringify(options.configPath)}
const baseArgs = ${JSON.stringify(options.baseArgs ?? [])}
const baseEnv = ${JSON.stringify(options.defaultEnv ?? {})}
${configLoader}
const child = spawn(
  process.execPath,
  [entrypointPath, ...baseArgs, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...baseEnv,
      ${options.serviceKind === "omniroute" ? "...runtimeEnv" : ""}
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
${configHelpers}
`,
    "utf8"
  )
  await makeExecutable(filePath)
  return filePath
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

function runManagedCommand(command, args, options = {}) {
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
  return `${options.packageName}-${releaseVersion}-${options.platform}-${options.arch}${getVendoredArchiveExtension(options.platform)}`
}

function buildVendoredAssetUrl(baseUrl, repository, releaseTag, assetName) {
  return `${baseUrl}/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`
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

function getVendoredArchiveExtension(platform) {
  return platform === "windows" ? ".zip" : ".tar.gz"
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
  if (process.platform === "win32") {
    await runManagedCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${escapePowerShell(archivePath.replaceAll("/", "\\"))}' -DestinationPath '${escapePowerShell(destination.replaceAll("/", "\\"))}' -Force`
    ])
    return
  }

  try {
    await runManagedCommand("unzip", ["-q", archivePath, "-d", destination])
  } catch {
    await runManagedCommand("bsdtar", ["-xf", archivePath, "-C", destination])
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
  await rename(sourceDirectory, targetDirectory)
}

function escapePowerShell(value) {
  return value.replaceAll("'", "''")
}
