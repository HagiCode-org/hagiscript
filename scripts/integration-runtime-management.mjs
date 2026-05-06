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
const manifestPath = path.join(repoRoot, "tests", "runtime", "fixtures", "runtime-manifest.yaml")
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
        managedRoot
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
    const alpha = report.components.find((item) => item.name === "alpha")
    const beta = report.components.find((item) => item.name === "beta")

    if (!alpha || alpha.status !== "installed" || !beta || beta.status !== "installed") {
      throw new Error(`Unexpected installed component state: ${stdout}`)
    }

    const alphaConfig = path.join(managedRoot, "config", "alpha", "config.txt")
    const betaConfig = path.join(managedRoot, "config", "beta", "config.txt")
    assertFile(alphaConfig)
    assertFile(betaConfig)
    assertIncludes(fs.readFileSync(alphaConfig, "utf8"), "component=alpha", "alpha template output")
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
        "alpha",
        "--purge"
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe"
      }
    )

    assertIncludes(stdout, "Runtime remove complete.", "runtime remove output")
    if (fs.existsSync(path.join(managedRoot, "config", "alpha"))) {
      throw new Error("Expected purge removal to clean alpha config directory.")
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
    finalResult
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

function log(message) {
  for (const line of message.split(/\r?\n/u)) {
    process.stdout.write(`[runtime-management-integration] ${line}\n`)
  }
}
