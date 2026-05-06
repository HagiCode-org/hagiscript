#!/usr/bin/env node

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
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
const managedRoot = path.join(tempRoot, "managed runtime")
const failingRoot = path.join(tempRoot, "managed runtime failure")
const summaryPath = path.join(tempRoot, "runtime-management-summary.md")
let installedTreeLines = []
let diagnostics
let finalResult = "failed"

try {
  diagnostics = await tracker.run("platform diagnostics", async () => {
    const collected = await collectPlatformDiagnostics({
      runProcess,
      repoRoot,
      tempRoot
    })
    log(formatDiagnostics(collected))
    return collected
  })

  await tracker.run("runtime install", async () => {
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
        stderr: "pipe"
      }
    )

    assertIncludes(stdout, "Runtime install complete.", "runtime install output")
  })

  await tracker.run("runtime state query", async () => {
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
        stderr: "pipe"
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
      [path.join(managedRoot, "bin"), path.join(managedRoot, "components")],
      "runtime program roots"
    )
    assertArrayEquals(
      report.layout?.externalDataRoots ?? [],
      [
        path.join(managedRoot, "config"),
        path.join(managedRoot, "logs"),
        path.join(managedRoot, "data")
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
      "components",
      "dotnet",
      "runtime",
      "current",
      "runtime-manifest.json"
    )
    const omnirouteConfig = path.join(managedRoot, "config", "omniroute", "config.yaml")
    const codeServerConfig = path.join(managedRoot, "config", "code-server", "config.yaml")
    const omnirouteBin = path.join(
      managedRoot,
      "bin",
      process.platform === "win32" ? "omniroute.cmd" : "omniroute"
    )
    const codeServerBin = path.join(
      managedRoot,
      "bin",
      process.platform === "win32" ? "code-server.cmd" : "code-server"
    )

    assertFile(dotnetManifest)
    assertFile(omnirouteConfig)
    assertFile(codeServerConfig)
    assertFile(omnirouteBin)
    assertFile(codeServerBin)
    assertIncludes(
      fs.readFileSync(omnirouteConfig, "utf8"),
      `runtimeRoot: "${managedRoot}"`,
      "omniroute config output"
    )
    assertIncludes(
      fs.readFileSync(codeServerConfig, "utf8"),
      "user-data-dir:",
      "code-server config output"
    )

    installedTreeLines = renderDirectoryTree(managedRoot)
  })

  await tracker.run("runtime remove purge", async () => {
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
        stderr: "pipe"
      }
    )

    assertIncludes(stdout, "Runtime remove complete.", "runtime remove output")
    if (fs.existsSync(path.join(managedRoot, "config", "code-server"))) {
      throw new Error("Expected purge removal to clean code-server config directory.")
    }
  })

  await tracker.run("runtime partial failure", async () => {
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
        stderr: "pipe"
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
        title: "Runtime Separation Checks",
        lines: [
          `- Program roots: ${path.join(managedRoot, "bin")}, ${path.join(managedRoot, "components")}`,
          `- External data roots: ${path.join(managedRoot, "config")}, ${path.join(managedRoot, "logs")}, ${path.join(managedRoot, "data")}`,
          "- Verified that program paths and external data paths remain separated in runtime state output"
        ]
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
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } else {
    log(`Keeping integration temp directory: ${tempRoot}`)
  }
}

async function runExpectFailure(command, args, cwd) {
  try {
    await runProcess(command, args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe"
    })
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`
  }

  throw new Error(`Expected command to fail: ${command} ${args.join(" ")}`)
}

function assertIncludes(output, expected, label) {
  if (!output.includes(expected)) {
    throw new Error(`Expected ${label} to include ${expected}. Output:\n${output}`)
  }
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
