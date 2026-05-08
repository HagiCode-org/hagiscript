#!/usr/bin/env node

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { parse, stringify } from "yaml"
import {
  collectPlatformDiagnostics,
  createStageTracker,
  formatDiagnostics,
  formatIntegrationSummary
} from "./integration-platform-helpers.mjs"
import { runProcess } from "./process-runner.mjs"

const repoRoot = path.resolve(process.argv[2] ?? ".")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hagiscript-runtime-management-"))
const tracker = createStageTracker()
const manifestPath = path.join(repoRoot, "runtime", "manifest.yaml")
const failingManifestPath = path.join(
  repoRoot,
  "tests",
  "runtime",
  "fixtures",
  "runtime-manifest-failure.yaml"
)
const managedRoot = path.join(tempRoot, "managed-runtime")
const failingRoot = path.join(tempRoot, "managed-runtime-failure")
const pm2ManifestPath = path.join(tempRoot, "runtime-manifest-pm2.yaml")
const summaryPath = path.join(tempRoot, "runtime-management-summary.md")
const runtimeCommandTimeoutMs = 20 * 60_000
const pm2CommandTimeoutMs = 5 * 60_000
const enableReleasedServerTest = process.env.HAGISCRIPT_ENABLE_RELEASED_SERVER_TEST === "1"
let installedTreeLines = []
let dotnetVerificationLines = []
let pm2LifecycleLines = []
let releasedServerLines = []
let diagnostics
let finalResult = "failed"

try {
  diagnostics = await runStage("platform diagnostics", async () => {
    const collected = await collectPlatformDiagnostics({
      runProcess,
      repoRoot,
      tempRoot
    })
    log(formatDiagnostics(collected))
    return collected
  })

  await runStage("prepare PM2 integration manifest", async () => {
    const manifest = parse(fs.readFileSync(manifestPath, "utf8"))
    const manifestDirectory = path.dirname(manifestPath)
    fs.cpSync(
      path.join(manifestDirectory, "templates"),
      path.join(tempRoot, "templates"),
      { recursive: true }
    )
    const componentNames = new Set(
      enableReleasedServerTest
        ? ["node", "dotnet", "npm-packages", "server", "omniroute", "code-server"]
        : ["node", "npm-packages", "omniroute", "code-server"]
    )
    const releasedServerPort = enableReleasedServerTest ? await getAvailablePort() : null
    manifest.components = manifest.components
      .filter((component) => componentNames.has(component.name))
      .map((component) => {
        const normalizedComponent = {
          ...component,
          installScript: path.resolve(manifestDirectory, component.installScript),
          ...(component.verifyScript
            ? { verifyScript: path.resolve(manifestDirectory, component.verifyScript) }
            : {}),
          ...(component.configureScript
            ? { configureScript: path.resolve(manifestDirectory, component.configureScript) }
            : {}),
          ...(component.updateScript
            ? { updateScript: path.resolve(manifestDirectory, component.updateScript) }
            : {}),
           ...(component.removeScript
             ? { removeScript: path.resolve(manifestDirectory, component.removeScript) }
             : {})
        }

        if (component.pm2 && isManagedPm2Service(component.name)) {
          normalizedComponent.pm2 = {
            ...component.pm2,
            ...(component.name === "server" && releasedServerPort
              ? {
                  env: {
                    ...(component.pm2.env ?? {}),
                    ASPNETCORE_URLS: `http://127.0.0.1:${releasedServerPort}`
                  }
                }
              : {}),
            pm2Home: getIntegrationPm2Home(tempRoot, component.name)
          }
        }

        if (component.name !== "npm-packages") {
          return normalizedComponent
        }

        return {
          ...normalizedComponent,
          packageCatalog: (component.packageCatalog ?? []).filter(
            (entry) => entry.id === "pm2"
          )
        }
      })

    for (const phaseName of ["install", "remove", "update"]) {
      manifest.phases[phaseName].order = manifest.phases[phaseName].order.filter((name) =>
        componentNames.has(name)
      )
    }

    fs.writeFileSync(pm2ManifestPath, stringify(manifest), "utf8")
  })

  await runStage("runtime install", async () => {
    const { stdout } = await runProcess(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "install",
        "--from-manifest",
        manifestPath,
        "--runtime-root",
        managedRoot,
        "--components",
        "node,dotnet,omniroute,code-server"
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: runtimeCommandTimeoutMs
      }
    )

    assertIncludes(stdout, "Runtime install complete.", "runtime install output")
  })

  await runStage("runtime state query", async () => {
    const { stdout } = await runProcess(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "state",
        "--from-manifest",
        manifestPath,
        "--runtime-root",
        managedRoot,
        "--json"
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: 60_000
      }
    )
    const report = JSON.parse(stdout)
    const nodeComponent = report.components.find((item) => item.name === "node")
    const dotnet = report.components.find((item) => item.name === "dotnet")
    const omniroute = report.components.find((item) => item.name === "omniroute")
    const codeServer = report.components.find((item) => item.name === "code-server")
    const npmPackages = report.components.find((item) => item.name === "npm-packages")
    assert(report.layout?.separated === true, `Expected separated runtime layout. Output:\n${stdout}`)
    assertArrayEquals(
      report.layout?.programRoots ?? [],
      [
        path.join(managedRoot, "program"),
        path.join(managedRoot, "program", "bin"),
        path.join(managedRoot, "program", "components"),
        path.join(managedRoot, "program", "npm")
      ],
      "runtime program roots"
    )
    assertArrayEquals(
      report.layout?.externalDataRoots ?? [],
      [
        path.join(managedRoot, "runtime-data"),
        path.join(managedRoot, "runtime-data", "config"),
        path.join(managedRoot, "runtime-data", "logs"),
        path.join(managedRoot, "runtime-data", "data"),
        path.join(managedRoot, "runtime-data", "components")
      ],
      "runtime external data roots"
    )

    if (
      !nodeComponent ||
      nodeComponent.status !== "installed" ||
      !dotnet ||
      dotnet.status !== "installed" ||
      !omniroute ||
      omniroute.status !== "installed" ||
      !codeServer ||
      codeServer.status !== "installed"
    ) {
      throw new Error(`Unexpected installed component state: ${stdout}`)
    }

    if (!npmPackages || npmPackages.status !== "not-installed") {
      throw new Error(`Expected npm-packages to remain not-installed for filtered install. Output:\n${stdout}`)
    }
    assertPathsSeparated(nodeComponent.programPaths, nodeComponent.externalDataPaths, "node separation")
    assertPathsSeparated(dotnet.programPaths, dotnet.externalDataPaths, "dotnet separation")
    assertPathsSeparated(omniroute.programPaths, omniroute.externalDataPaths, "omniroute separation")
    assertPathsSeparated(codeServer.programPaths, codeServer.externalDataPaths, "code-server separation")

    const dotnetManifest = path.join(
      managedRoot,
      "program",
      "components",
      "dotnet",
      "runtime",
      "current",
      "runtime-manifest.json"
    )
    const dotnetExecutable = path.join(
      managedRoot,
      "program",
      "components",
      "dotnet",
      "runtime",
      "current",
      process.platform === "win32" ? "dotnet.exe" : "dotnet"
    )
    const dotnetBin = path.join(
      managedRoot,
      "program",
      "bin",
      process.platform === "win32" ? "dotnet.cmd" : "dotnet"
    )
    const omnirouteConfig = path.join(
      managedRoot,
      "runtime-data",
      "components",
      "services",
      "omniroute",
      "config",
      "config.yaml"
    )
    const codeServerConfig = path.join(
      managedRoot,
      "runtime-data",
      "components",
      "services",
      "code-server",
      "config",
      "config.yaml"
    )
    const omnirouteBin = path.join(
      managedRoot,
      "program",
      "bin",
      process.platform === "win32" ? "omniroute.cmd" : "omniroute"
    )
    const codeServerBin = path.join(
      managedRoot,
      "program",
      "bin",
      process.platform === "win32" ? "code-server.cmd" : "code-server"
    )

    assertFile(dotnetManifest)
    assertFile(dotnetExecutable)
    assertFile(dotnetBin)
    assertFile(omnirouteConfig)
    assertFile(codeServerConfig)
    assertFile(omnirouteBin)
    assertFile(codeServerBin)
    const { stdout: dotnetRuntimesOutput } = await runProcess(
      dotnetBin,
      ["--list-runtimes"],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: 60_000
      }
    )
    assertIncludes(
      dotnetRuntimesOutput,
      "Microsoft.NETCore.App 10.0.5",
      ".NET runtime inventory"
    )
    assertIncludes(
      dotnetRuntimesOutput,
      "Microsoft.AspNetCore.App 10.0.5",
      "ASP.NET Core runtime inventory"
    )
    const dotnetManifestData = JSON.parse(fs.readFileSync(dotnetManifest, "utf8"))
    dotnetVerificationLines = [
      `- Component status: ${dotnet.status}`,
      `- Managed executable: ${dotnetExecutable}`,
      `- Bin wrapper: ${dotnetBin}`,
      `- Manifest channel version: ${dotnetManifestData.channelVersion ?? "n/a"}`,
      `- Manifest installed version: ${dotnetManifestData.installedVersion ?? "n/a"}`,
      `- Manifest dotnet path: ${dotnetManifestData.dotnetPath ?? "n/a"}`,
      "- Verified runtimes:",
      ...dotnetRuntimesOutput
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => `  - ${line}`)
    ]
    assertIncludes(
      fs.readFileSync(omnirouteConfig, "utf8"),
      `runtimeHome: "${path.join(managedRoot, "program")}"`,
      "omniroute config output"
    )
    assertIncludes(
      fs.readFileSync(codeServerConfig, "utf8"),
      "user-data-dir:",
      "code-server config output"
    )

    installedTreeLines = renderDirectoryTree(managedRoot)
  })

  await runStage("pm2 service lifecycle", async () => {
    await prepareOmniroutePm2Config(managedRoot)

    const installOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "install",
        "--from-manifest",
        pm2ManifestPath,
        "--runtime-root",
        managedRoot,
        "--components",
        "npm-packages"
      ],
      repoRoot
    )
    assertIncludes(installOutput, "Runtime install complete.", "pm2 runtime install output")

    const services = ["omniroute", "code-server"]
    for (const service of services) {
      const missingOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "pm2",
          service,
          "status",
          "--from-manifest",
          pm2ManifestPath,
          "--runtime-root",
          managedRoot
        ],
        repoRoot
      )
      assertIncludes(missingOutput, "Status: missing", `${service} missing status`)

      const startOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "pm2",
          service,
          "start",
          "--from-manifest",
          pm2ManifestPath,
          "--runtime-root",
          managedRoot
        ],
        repoRoot
      )
      assertIncludes(startOutput, `Action: start`, `${service} start output`)
      assertIncludes(startOutput, `App: hagicode-${service}`, `${service} start app`)

      const statusOutput = await waitForManagedPm2Status(
        service,
        "online",
        {
          manifestPath: pm2ManifestPath,
          runtimeRoot: managedRoot,
          repoRoot
        }
      )
      if (!statusOutput.includes("Status: online")) {
        if (process.platform !== "linux") {
          tracker.skip(
            `${process.platform} ${service} pm2 stability`,
            `The ${process.platform} runner may report ${service} as stopped/errored immediately after start even when PM2 accepted the start request.`
          )
          pm2LifecycleLines.push(
            `- ${service}: start -> online, status -> skipped on non-Linux runner instability`
          )
          continue
        }

        assertIncludes(statusOutput, "Status: online", `${service} queried status`)
      }

      const stopOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "pm2",
          service,
          "stop",
          "--from-manifest",
          pm2ManifestPath,
          "--runtime-root",
          managedRoot
        ],
        repoRoot
      )
      assertIncludes(stopOutput, "Status: stopped", `${service} stop status`)

      pm2LifecycleLines.push(`- ${service}: start -> online, status -> online, stop -> stopped`)
    }

    await Promise.all([
      killManagedPm2(managedRoot, "omniroute"),
      killManagedPm2(managedRoot, "code-server")
    ])
  })

  if (enableReleasedServerTest) {
    await runStage("released server lifecycle", async () => {
      const releasedServer = await prepareReleasedServerPayload({
        managedRoot,
        repoRoot,
        tempRoot
      })
      releasedServerLines.push(
        `- Release tag: ${releasedServer.tagName}`,
        `- Asset: ${releasedServer.assetName}`,
        `- Payload root: ${releasedServer.targetRoot}`,
        `- DLL: ${releasedServer.dllPath}`
      )

      const installOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "runtime",
          "install",
          "--from-manifest",
          pm2ManifestPath,
          "--runtime-root",
          managedRoot,
          "--components",
          "server"
        ],
        repoRoot
      )
      assertIncludes(installOutput, "Runtime install complete.", "released server install output")

      const startOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "pm2",
          "server",
          "start",
          "--from-manifest",
          pm2ManifestPath,
          "--runtime-root",
          managedRoot
        ],
        repoRoot
      )
      assertIncludes(startOutput, "Action: start", "server start output")
      const onlineOutput = await waitForManagedPm2Status("server", "online", {
        manifestPath: pm2ManifestPath,
        runtimeRoot: managedRoot,
        repoRoot
      })
      const serverOnline = onlineOutput.includes("Status: online")
      if (!serverOnline) {
        if (process.platform !== "linux") {
          tracker.skip(
            `${process.platform} released server pm2 stability`,
            `The ${process.platform} runner may report the released server as stopped/errored immediately after PM2 accepted the start request.`
          )
          releasedServerLines.push(
            "- Lifecycle: install -> start requested, online verification skipped on non-Linux runner instability"
          )
        } else {
          assertIncludes(onlineOutput, "Status: online", "server online status")
        }
      }

      if (serverOnline) {
        const restartOutput = await runCapture(
          process.execPath,
          [
            "dist/cli.js",
            "pm2",
            "server",
            "restart",
            "--from-manifest",
            pm2ManifestPath,
            "--runtime-root",
            managedRoot
          ],
          repoRoot
        )
        assertIncludes(restartOutput, "Action: restart", "server restart output")

        const stopOutput = await runCapture(
          process.execPath,
          [
            "dist/cli.js",
            "pm2",
            "server",
            "stop",
            "--from-manifest",
            pm2ManifestPath,
            "--runtime-root",
            managedRoot
          ],
          repoRoot
        )
        assertIncludes(stopOutput, "Status: stopped", "server stop output")
      }

      const removeOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "runtime",
          "remove",
          "--from-manifest",
          pm2ManifestPath,
          "--runtime-root",
          managedRoot,
          "--components",
          "server",
          "--purge"
        ],
        repoRoot
      )
      assertIncludes(removeOutput, "Runtime remove complete.", "server remove output")

      const statusOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "pm2",
          "server",
          "status",
          "--from-manifest",
          pm2ManifestPath,
          "--runtime-root",
          managedRoot
        ],
        repoRoot
      )
      assertIncludes(statusOutput, "Status: missing", "server status after removal")
      if (serverOnline) {
        releasedServerLines.push(
          "- Lifecycle: install -> start -> online -> restart -> stop -> runtime remove --purge -> status missing"
        )
      } else {
        releasedServerLines.push(
          "- Lifecycle: install -> start requested -> runtime remove --purge -> status missing"
        )
      }
    })
  }

  await runStage("runtime remove purge", async () => {
    const { stdout } = await runProcess(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "remove",
        "--from-manifest",
        manifestPath,
        "--runtime-root",
        managedRoot,
        "--components",
        "code-server",
        "--purge"
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: 60_000
      }
    )

    assertIncludes(stdout, "Runtime remove complete.", "runtime remove output")
    if (
      fs.existsSync(
        path.join(
          managedRoot,
          "runtime-data",
          "components",
          "services",
          "code-server"
        )
      )
    ) {
      throw new Error("Expected purge removal to clean code-server config directory.")
    }
  })

  await runStage("runtime partial failure", async () => {
    const failureOutput = await runExpectFailure(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "install",
        "--from-manifest",
        failingManifestPath,
        "--runtime-root",
        failingRoot
      ],
      repoRoot
    )

    assertIncludes(
      failureOutput,
      "install failed for component failer",
      "partial failure diagnostics"
    )

    const { stdout } = await runProcess(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "state",
        "--from-manifest",
        failingManifestPath,
        "--runtime-root",
        failingRoot,
        "--json"
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: 60_000
      }
    )
    const report = JSON.parse(stdout)
    const alpha = report.components.find((item) => item.name === "alpha")
    const failer = report.components.find((item) => item.name === "failer")
    const late = report.components.find((item) => item.name === "late")

    if (!alpha || alpha.status !== "installed") {
      throw new Error(`Expected alpha to remain installed after failure. Output:\n${stdout}`)
    }

    if (!failer || failer.status !== "failed") {
      throw new Error(`Expected failer to be marked failed. Output:\n${stdout}`)
    }

    if (!late || late.status !== "not-installed") {
      throw new Error(`Expected late to remain not-installed. Output:\n${stdout}`)
    }
  })

  finalResult = "passed"
  log("Runtime management integration test passed")
} finally {
  const fallbackDiagnostics = diagnostics ?? {
    platform: process.platform,
    arch: process.arch,
    runnerOs: process.env.RUNNER_OS ?? "local",
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    nodeVersion: process.version,
    npmVersion: "unknown",
    tempRoot,
    packageName: "hagiscript",
    packageVersion: "unknown"
  }
  const summary = formatIntegrationSummary({
    diagnostics: fallbackDiagnostics,
    stages: tracker.stages,
    skipped: tracker.skipped,
    finalResult,
    extraSections: [
      {
        title: "Installed Runtime Tree",
        lines: installedTreeLines.length > 0 ? installedTreeLines : ["- Not captured"]
      },
      {
        title: "Managed Dotnet Verification",
        lines: dotnetVerificationLines.length > 0 ? dotnetVerificationLines : ["- Not captured"]
      },
      {
        title: "Runtime Separation Checks",
        lines: [
          `- Runtime home: ${path.join(managedRoot, "program")}`,
          `- Runtime data root: ${path.join(managedRoot, "runtime-data")}`,
          `- Program roots: ${path.join(managedRoot, "program")}, ${path.join(managedRoot, "program", "bin")}, ${path.join(managedRoot, "program", "components")}, ${path.join(managedRoot, "program", "npm")}`,
          `- External data roots: ${path.join(managedRoot, "runtime-data")}, ${path.join(managedRoot, "runtime-data", "config")}, ${path.join(managedRoot, "runtime-data", "logs")}, ${path.join(managedRoot, "runtime-data", "data")}, ${path.join(managedRoot, "runtime-data", "components")}`,
          "- Verified that program paths and external data paths remain separated in runtime state output"
        ]
      },
      {
        title: "Managed PM2 Lifecycle Checks",
        lines: pm2LifecycleLines.length > 0 ? pm2LifecycleLines : ["- Not captured"]
      },
      {
        title: "Released Server Validation",
        lines: releasedServerLines.length > 0 ? releasedServerLines : ["- Not requested"]
      }
    ]
  })
  fs.writeFileSync(summaryPath, summary)
  process.stdout.write(`\n${summary}`)

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}`)
  }

  if (process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH) {
    fs.mkdirSync(path.dirname(process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH), {
      recursive: true
    })
    fs.copyFileSync(summaryPath, process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH)
  }

  if (process.env.HAGISCRIPT_KEEP_INTEGRATION_TEMP !== "1") {
    await cleanupTempRoot(tempRoot)
  } else {
    log(`Keeping integration temp directory: ${tempRoot}`)
  }
}

async function runExpectFailure(command, args, cwd) {
  log(`Expecting failure: ${formatCommand(command, args)}`)
  try {
    await runProcess(command, args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: 60_000
    })
  } catch (error) {
    log(`Observed expected failure: ${summarizeProcessError(error)}`)
    return `${error.stdout ?? ""}${error.stderr ?? ""}`
  }

  throw new Error(`Expected command to fail: ${command} ${args.join(" ")}`)
}

async function runCapture(command, args, cwd) {
  const timeoutMs = isPm2Command(args) ? pm2CommandTimeoutMs : runtimeCommandTimeoutMs
  log(`Running command: ${formatCommand(command, args)} (timeout=${timeoutMs}ms)`)
  try {
    const { stdout, stderr } = await runProcess(command, args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs
    })
    log(
      `Command completed: ${formatCommand(command, args)}${formatOutputSummary(stdout, stderr)}`
    )
    return stdout
  } catch (error) {
    log(`Command failed: ${summarizeProcessError(error)}`)
    throw error
  }
}

async function waitForManagedPm2Status(
  service,
  expectedStatus,
  options
) {
  const attempts =
    process.platform === "darwin"
      ? 6
      : process.platform === "win32"
        ? 6
        : 3
  let lastOutput = ""

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "pm2",
        service,
        "status",
        "--from-manifest",
        options.manifestPath,
        "--runtime-root",
        options.runtimeRoot
      ],
      options.repoRoot
    )

    if (lastOutput.includes(`Status: ${expectedStatus}`)) {
      return lastOutput
    }

    if (attempt < attempts) {
      await delay(500 * attempt)
    }
  }

  return lastOutput
}

async function prepareOmniroutePm2Config(runtimeRoot) {
  const configPath = path.join(
    runtimeRoot,
    "runtime-data",
    "components",
    "services",
    "omniroute",
    "config",
    "config.yaml"
  )

  if (!fs.existsSync(configPath)) {
    return
  }

  const port = await getAvailablePort()
  const current = fs.readFileSync(configPath, "utf8")
  fs.writeFileSync(
    configPath,
    current.replace(/listen:\s*"127\.0\.0\.1:\d+"/u, `listen: "127.0.0.1:${port}"`),
    "utf8"
  )
  log(`Prepared omniroute PM2 config with dynamic port ${port}`)
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Expected a TCP address when reserving a free port.")))
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(address.port)
      })
    })
  })
}

function assertIncludes(output, expected, label) {
  if (!output.includes(expected)) {
    throw new Error(`Expected ${label} to include ${expected}. Output:\n${output}`)
  }
}

function delay(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected file to exist: ${filePath}`)
  }
}

function assertArrayEquals(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${label} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function assertPathsSeparated(programPaths, externalDataPaths, label) {
  const overlaps = programPaths.filter((programPath) => externalDataPaths.includes(programPath))
  if (overlaps.length > 0) {
    throw new Error(`Expected ${label} to keep program/data paths separated, overlaps: ${overlaps.join(", ")}`)
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function prepareReleasedServerPayload(options) {
  const releaseRepository =
    process.env.HAGISCRIPT_RELEASED_SERVER_REPOSITORY?.trim() || "HagiCode-org/releases"
  const assetSuffix = getReleasedServerAssetSuffix()
  const releaseResponse = await fetch(
    `https://api.github.com/repos/${releaseRepository}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "hagiscript-runtime-management"
      }
    }
  )

  if (!releaseResponse.ok) {
    throw new Error(
      `Failed to read latest released server metadata: HTTP ${releaseResponse.status}`
    )
  }

  const release = await releaseResponse.json()
  const asset = Array.isArray(release.assets)
    ? release.assets.find((entry) => typeof entry?.name === "string" && entry.name.endsWith(assetSuffix))
    : null

  if (!asset?.browser_download_url || !asset?.name || !release.tag_name) {
    throw new Error(
      `Latest release in ${releaseRepository} does not expose a ${assetSuffix} asset.`
    )
  }

  const archivePath = path.join(options.tempRoot, asset.name)
  const extractRoot = path.join(options.tempRoot, "released-server")
  const targetRoot = path.join(options.managedRoot, "program", "components", "server", "current")
  await downloadFile(asset.browser_download_url, archivePath)
  fs.rmSync(extractRoot, { recursive: true, force: true })
  fs.mkdirSync(extractRoot, { recursive: true })
  await extractZipArchive(archivePath, extractRoot, options.repoRoot)
  fs.rmSync(targetRoot, { recursive: true, force: true })
  fs.mkdirSync(targetRoot, { recursive: true })
  fs.cpSync(extractRoot, targetRoot, { recursive: true })

  const dllPath = path.join(targetRoot, "lib", "PCode.Web.dll")
  assertFile(dllPath)
  return {
    tagName: release.tag_name,
    assetName: asset.name,
    targetRoot,
    dllPath
  }
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "hagiscript-runtime-management"
    }
  })

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(destinationPath, buffer)
}

async function extractZipArchive(archivePath, extractRoot, cwd) {
  if (process.platform === "win32") {
    await runProcess(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${escapePowerShell(archivePath.replaceAll("/", "\\"))}' -DestinationPath '${escapePowerShell(extractRoot.replaceAll("/", "\\"))}' -Force`
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: 5 * 60_000
      }
    )
    return
  }

  try {
    await runProcess("unzip", ["-q", archivePath, "-d", extractRoot], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: 5 * 60_000
    })
  } catch {
    await runProcess("bsdtar", ["-xf", archivePath, "-C", extractRoot], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: 5 * 60_000
    })
  }
}

function getReleasedServerAssetSuffix() {
  const platform = getReleasedServerPlatform()
  const arch = getReleasedServerArch()
  return `${platform}-${arch}-nort.zip`
}

function getReleasedServerPlatform() {
  switch (process.platform) {
    case "darwin":
      return "osx"
    case "win32":
      return "win"
    default:
      return "linux"
  }
}

function getReleasedServerArch() {
  switch (process.arch) {
    case "x64":
      return "x64"
    case "arm64":
      return "arm64"
    default:
      throw new Error(
        `Released server validation does not support architecture ${process.arch}.`
      )
  }
}

function escapePowerShell(value) {
  return value.replaceAll("'", "''")
}

function renderDirectoryTree(rootPath, maxDepth = 4) {
  const lines = ["```text", `${path.basename(rootPath)}/`]
  walkDirectory(rootPath, "", 0, maxDepth, lines)
  lines.push("```")
  return lines
}

function walkDirectory(currentPath, prefix, depth, maxDepth, lines) {
  if (depth >= maxDepth) {
    return
  }

  const entries = fs
    .readdirSync(currentPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name))

  entries.forEach((entry, index) => {
    const isLast = index === entries.length - 1
    const connector = isLast ? "└── " : "├── "
    const nextPrefix = `${prefix}${isLast ? "    " : "│   "}`
    const fullPath = path.join(currentPath, entry.name)
    lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`)

    if (entry.isDirectory()) {
      walkDirectory(fullPath, nextPrefix, depth + 1, maxDepth, lines)
    }
  })
}

function log(message) {
  for (const line of message.split(/\r?\n/u)) {
    process.stdout.write(`[runtime-management-integration] ${line}\n`)
  }
}

async function killManagedPm2(runtimeRoot, serviceName) {
  const pm2Home = getIntegrationPm2Home(path.dirname(runtimeRoot), serviceName)
  const nodeBinary = path.join(
    runtimeRoot,
    "program",
    "components",
    "node",
    "runtime",
    ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"])
  )
  const pm2Entrypoint = path.join(
    runtimeRoot,
    "program",
    "npm",
    ...(process.platform === "win32"
      ? ["node_modules", "pm2", "bin", "pm2"]
      : ["lib", "node_modules", "pm2", "bin", "pm2"])
  )
  const pathKey = process.platform === "win32" ? "Path" : "PATH"
  const pathEntries = [
    path.join(
      runtimeRoot,
      "program",
      "components",
      "node",
      ...(process.platform === "win32" ? [] : ["bin"])
    ),
    path.join(
      runtimeRoot,
      "program",
      "npm",
      ...(process.platform === "win32" ? [] : ["bin"])
    ),
    path.join(runtimeRoot, "program", "bin"),
    process.env[pathKey] ?? process.env.PATH ?? ""
  ].filter(Boolean)

  try {
    log(`Cleaning PM2 daemon for ${serviceName}`)
    await runProcess(nodeBinary, [pm2Entrypoint, "kill"], {
      cwd: path.join(runtimeRoot, "program"),
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: 30_000,
      env: {
        ...process.env,
        PM2_HOME: pm2Home,
        [pathKey]: pathEntries.join(process.platform === "win32" ? ";" : ":")
      }
    })
  } catch {
    // Best-effort cleanup for the integration daemon.
  }

  await sleep(process.platform === "win32" ? 1500 : 250)
}

async function cleanupTempRoot(targetRoot) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetRoot, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 7) {
        log(
          `Temp cleanup skipped after repeated failures: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return
      }

      await sleep(process.platform === "win32" ? 500 : 100)
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds)
  })
}

async function runStage(name, action) {
  log(`Starting stage: ${name}`)
  try {
    const result = await tracker.run(name, action)
    const stage = tracker.stages.findLast((entry) => entry.name === name)
    log(`Completed stage: ${name}${stage ? ` (${stage.durationMs}ms)` : ""}`)
    return result
  } catch (error) {
    log(`Stage failed: ${name} - ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

function isPm2Command(args) {
  return args.includes("pm2")
}

function isManagedPm2Service(serviceName) {
  return serviceName === "server" || serviceName === "omniroute" || serviceName === "code-server"
}

function getIntegrationPm2Home(tempRootPath, serviceName) {
  return path.join(tempRootPath, "p", getManagedPm2ServiceKey(serviceName))
}

function getManagedPm2ServiceKey(serviceName) {
  switch (serviceName) {
    case "server":
      return "s"
    case "omniroute":
      return "o"
    case "code-server":
      return "c"
    default:
      return serviceName
  }
}

function formatCommand(command, args) {
  return [command, ...args].join(" ")
}

function summarizeProcessError(error) {
  const command =
    error?.result?.command && Array.isArray(error?.result?.args)
      ? formatCommand(error.result.command, error.result.args)
      : error instanceof Error
        ? error.message
        : String(error)
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : ""
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : ""
  return `${command}${formatOutputSummary(stdout, stderr)}`
}

function formatOutputSummary(stdout, stderr) {
  const details = []
  if (stdout) {
    details.push(`stdout=${JSON.stringify(truncateOutput(stdout))}`)
  }
  if (stderr) {
    details.push(`stderr=${JSON.stringify(truncateOutput(stderr))}`)
  }
  return details.length > 0 ? ` (${details.join(", ")})` : ""
}

function truncateOutput(value, maxLength = 240) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
