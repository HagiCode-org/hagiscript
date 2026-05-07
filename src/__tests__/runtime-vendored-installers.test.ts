import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"
import { execa } from "execa"

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const installCodeServerScript = path.join(
  repoRoot,
  "runtime",
  "scripts",
  "install-code-server.mjs"
)
const installOmnirouteScript = path.join(
  repoRoot,
  "runtime",
  "scripts",
  "install-omniroute.mjs"
)
const releaseVersion = "2026.0506.0029"
const releaseTag = `v${releaseVersion}`
const runTest = process.platform === "win32" ? it.skip : it

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("vendored runtime installers", () => {
  runTest("installs code-server from the vendored GitHub release archive", async () => {
    const runtimeRoot = await makeRuntimeRoot("code-server")
    const outputPath = path.join(runtimeRoot, "code-server-output.json")
    const vendoredPlatform = getVendoredPlatform()
    const vendoredArch = getVendoredArch()
    const assetName = `code-server-${releaseVersion}-${vendoredPlatform}-${vendoredArch}.tar.gz`
    const assetBuffer = createTarGzArchive("release", {
      "out/node/entry.js": createRecordedEntrypoint({
        includeEnvKeys: [],
        moduleType: "cjs"
      })
    })
    const releaseServer = await startVendoredReleaseServer([
      { name: assetName, contents: assetBuffer }
    ])

    try {
      await execa(process.execPath, [installCodeServerScript], {
        cwd: repoRoot,
        env: createRuntimeScriptEnv(runtimeRoot, "code-server", releaseServer.baseUrl)
      })

      const launcherPath = path.join(
        runtimeRoot,
        "program",
        "components",
        "bundled",
        "code-server",
        "current",
        "code-server-launcher.mjs"
      )
      const configPath = path.join(
        runtimeRoot,
        "runtime-data",
        "components",
        "services",
        "code-server",
        "config",
        "config.yaml"
      )

      await execa(process.execPath, [launcherPath, "--version"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          TEST_OUTPUT_PATH: outputPath
        }
      })

      const launched = JSON.parse(await readFile(outputPath, "utf8"))
      expect(launched.argv).toEqual(["--config", configPath, "--version"])

      const markerPath = path.join(
        runtimeRoot,
        "program",
        "components",
        "bundled",
        "code-server",
        ".hagicode-runtime.json"
      )
      const marker = JSON.parse(await readFile(markerPath, "utf8"))
      expect(marker.vendoredReleaseRepository).toBe("HagiCode-org/vendered")
      expect(marker.vendoredReleaseTag).toBe(releaseTag)
      expect(marker.vendoredAssetName).toBe(assetName)
      expect(marker.entrypointPath).toContain(path.join("current", "out", "node", "entry.js"))
    } finally {
      await releaseServer.close()
    }
  })

  runTest("installs omniroute from the vendored GitHub release archive", async () => {
    const runtimeRoot = await makeRuntimeRoot("omniroute")
    const outputPath = path.join(runtimeRoot, "omniroute-output.json")
    const vendoredPlatform = getVendoredPlatform()
    const vendoredArch = getVendoredArch()
    const assetName = `omniroute-${releaseVersion}-${vendoredPlatform}-${vendoredArch}.tar.gz`
    const assetBuffer = createTarGzArchive(
      `omniroute-${releaseVersion}-${vendoredPlatform}-${vendoredArch}`,
      {
        "bin/omniroute.mjs": createRecordedEntrypoint({
          includeEnvKeys: ["DATA_DIR", "LOG_DIR", "PORT"],
          moduleType: "esm"
        })
      }
    )
    const releaseServer = await startVendoredReleaseServer([
      { name: assetName, contents: assetBuffer }
    ])

    try {
      await execa(process.execPath, [installOmnirouteScript], {
        cwd: repoRoot,
        env: createRuntimeScriptEnv(runtimeRoot, "omniroute", releaseServer.baseUrl)
      })

      const launcherPath = path.join(
        runtimeRoot,
        "program",
        "components",
        "bundled",
        "omniroute",
        "current",
        "omniroute-launcher.mjs"
      )
      const configPath = path.join(
        runtimeRoot,
        "runtime-data",
        "components",
        "services",
        "omniroute",
        "config",
        "config.yaml"
      )
      const runtimeDataHome = path.join(
        runtimeRoot,
        "runtime-data",
        "components",
        "services",
        "omniroute"
      )

      await execa(process.execPath, [launcherPath, "--help"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          TEST_OUTPUT_PATH: outputPath
        }
      })

      const launched = JSON.parse(await readFile(outputPath, "utf8"))
      expect(launched.argv).toEqual(["--no-open", "--help"])
      expect(launched.env.DATA_DIR).toBe(runtimeDataHome)
      expect(launched.env.LOG_DIR).toBe(path.join(runtimeDataHome, "logs"))
      expect(launched.env.PORT).toBe("39001")
      expect(await readFile(configPath, "utf8")).toContain('listen: "127.0.0.1:39001"')
    } finally {
      await releaseServer.close()
    }
  })
})

async function makeRuntimeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `hagiscript-${prefix}-`))
  tempRoots.push(root)
  return root
}

function createRuntimeScriptEnv(
  runtimeRoot: string,
  componentName: "code-server" | "omniroute",
  baseUrl: string
) {
  const runtimeHome = path.join(runtimeRoot, "program")
  const runtimeDataRoot = path.join(runtimeRoot, "runtime-data")
  const currentRoot = path.join(runtimeHome, "components", "bundled", componentName, "current")
  const componentDataHome = path.join(
    runtimeDataRoot,
    "components",
    "services",
    componentName
  )

  return {
    ...process.env,
    HAGISCRIPT_RUNTIME_ROOT: runtimeRoot,
    HAGICODE_RUNTIME_HOME: runtimeHome,
    HAGICODE_RUNTIME_DATA_HOME: componentDataHome,
    HAGISCRIPT_RUNTIME_BIN_DIR: path.join(runtimeHome, "bin"),
    HAGISCRIPT_RUNTIME_CONFIG_DIR: path.join(runtimeDataRoot, "config"),
    HAGISCRIPT_RUNTIME_LOGS_DIR: path.join(runtimeDataRoot, "logs"),
    HAGISCRIPT_RUNTIME_DATA_DIR: path.join(runtimeDataRoot, "data"),
    HAGISCRIPT_RUNTIME_STATE_PATH: path.join(runtimeDataRoot, "state.json"),
    HAGISCRIPT_RUNTIME_COMPONENT_NAME: componentName,
    HAGISCRIPT_RUNTIME_COMPONENT_TYPE: "bundled-runtime",
    HAGISCRIPT_RUNTIME_COMPONENT_ROOT: path.dirname(currentRoot),
    HAGISCRIPT_RUNTIME_COMPONENT_CONFIG_DIR: path.join(componentDataHome, "config"),
    HAGISCRIPT_RUNTIME_COMPONENT_DATA_DIR: componentDataHome,
    HAGISCRIPT_RUNTIME_COMPONENT_LOGS_DIR: path.join(componentDataHome, "logs"),
    HAGISCRIPT_RUNTIME_COMPONENT_PM2_HOME: path.join(componentDataHome, "pm2"),
    HAGISCRIPT_RUNTIME_TEMPLATE_DIR: path.join(repoRoot, "runtime", "templates"),
    HAGISCRIPT_RUNTIME_COMPONENT_VERSION:
      componentName === "code-server" ? "4.117.0" : "3.6.9",
    HAGISCRIPT_RUNTIME_VENDORED_REPOSITORY: "HagiCode-org/vendered",
    HAGISCRIPT_RUNTIME_VENDORED_BASE_URL: baseUrl
  }
}

async function startVendoredReleaseServer(
  assets: Array<{ name: string; contents: Buffer }>
) {
  const assetsByName = new Map(assets.map((asset) => [asset.name, asset.contents]))
  const server = createServer((request, response) => {
    if (
      request.url?.startsWith(
        `/HagiCode-org/vendered/releases/download/${encodeURIComponent(releaseTag)}/`
      )
    ) {
      const assetName = decodeURIComponent(
        request.url.slice(
          `/HagiCode-org/vendered/releases/download/${encodeURIComponent(releaseTag)}/`.length
        )
      )
      const assetBuffer = assetsByName.get(assetName)
      if (!assetBuffer) {
        response.statusCode = 404
        response.end("missing asset")
        return
      }

      response.setHeader("Content-Type", "application/gzip")
      response.setHeader("Content-Length", String(assetBuffer.length))
      response.end(assetBuffer)
      return
    }

    response.statusCode = 404
    response.end("not found")
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Expected vendored release test server to expose a TCP address.")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

function createTarGzArchive(rootDirectory: string, files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([relativePath, content]) =>
    createTarFileEntry(`${rootDirectory}/${relativePath}`, Buffer.from(content, "utf8"))
  )
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

function createTarFileEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0)
  writeTarString(header, name, 0, 100)
  writeTarOctal(header, 0o644, 100, 8)
  writeTarOctal(header, 0, 108, 8)
  writeTarOctal(header, 0, 116, 8)
  writeTarOctal(header, content.length, 124, 12)
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = "0".charCodeAt(0)
  writeTarString(header, "ustar", 257, 6)
  writeTarString(header, "00", 263, 2)
  writeTarChecksum(header)

  const paddingLength = (512 - (content.length % 512)) % 512
  return Buffer.concat([header, content, Buffer.alloc(paddingLength)])
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number) {
  Buffer.from(value).copy(buffer, offset, 0, Math.min(length, Buffer.byteLength(value)))
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number) {
  const octal = value.toString(8).padStart(length - 1, "0")
  buffer.write(octal, offset, length - 1, "ascii")
  buffer[offset + length - 1] = 0
}

function writeTarChecksum(buffer: Buffer) {
  let checksum = 0
  for (const byte of buffer.values()) {
    checksum += byte
  }

  const rendered = checksum.toString(8).padStart(6, "0")
  buffer.write(rendered, 148, 6, "ascii")
  buffer[154] = 0
  buffer[155] = 0x20
}

function createRecordedEntrypoint(options: {
  includeEnvKeys: string[]
  moduleType: "cjs" | "esm"
}) {
  const envEntries = options.includeEnvKeys
    .map((key) => `    ${JSON.stringify(key)}: process.env[${JSON.stringify(key)}] ?? null`)
    .join(",\n")
  const fileSystemImport =
    options.moduleType === "esm"
      ? 'import { writeFile } from "node:fs/promises"'
      : 'const { writeFile } = require("node:fs/promises")'

  return `#!/usr/bin/env node
${fileSystemImport}

async function main() {
  await writeFile(
    process.env.TEST_OUTPUT_PATH,
    JSON.stringify({
      argv: process.argv.slice(2),
      env: {
${envEntries || "      "}
      }
    })
  )
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + "\\n")
  process.exit(1)
})
`
}

function getVendoredPlatform() {
  switch (process.platform) {
    case "darwin":
      return "macos"
    case "win32":
      return "windows"
    default:
      return "linux"
  }
}

function getVendoredArch() {
  switch (process.arch) {
    case "x64":
      return "amd64"
    case "arm64":
      return "arm64"
    default:
      throw new Error(`Unsupported test architecture: ${process.arch}`)
  }
}
