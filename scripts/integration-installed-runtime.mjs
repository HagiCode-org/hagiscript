#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execa } from "execa";
import {
  binCommand,
  collectPlatformDiagnostics,
  createStageTracker,
  executableName,
  formatDiagnostics,
  formatIntegrationSummary,
  runtimeNodeCommand,
  runtimeNpmCommand
} from "./integration-platform-helpers.mjs";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hagiscript-it-"));
const packageInstallRoot = path.join(tempRoot, "installed-package");
const runtimePath = path.join(tempRoot, "custom-node-runtime");
const manifestPath = path.join(tempRoot, "manifest.json");
const invalidManifestPath = path.join(tempRoot, "invalid-manifest.json");
const summaryPath = path.join(tempRoot, "integration-summary.md");
const npmCommand = executableName("npm");
const registryMirror =
  process.env.HAGISCRIPT_INTEGRATION_REGISTRY_MIRROR?.trim() ||
  "https://registry.npmmirror.com/";
const tracker = createStageTracker();
let diagnostics;
let finalResult = "failed";

try {
  fs.mkdirSync(packageInstallRoot, { recursive: true });

  diagnostics = await tracker.run("platform diagnostics", async () => {
    const collected = await collectPlatformDiagnostics({ execa, repoRoot, tempRoot });
    log(formatDiagnostics(collected));
    return collected;
  });

  const tarballPath = await tracker.run("package packing", async () => {
    log("Packing current build artifact");
    const { stdout: packOutput } = await execa(
      npmCommand,
      ["pack", "--json", "--pack-destination", tempRoot],
      { cwd: repoRoot, stdout: "pipe" }
    );
    const [packSummary] = JSON.parse(packOutput);
    return path.join(tempRoot, packSummary.filename);
  });

  await tracker.run("dependency setup", async () => {
    log(`Installing packed package into ${packageInstallRoot}`);
    await execa(npmCommand, ["init", "-y"], {
      cwd: packageInstallRoot,
      stdout: "ignore",
      stderr: "ignore"
    });
    await execa(npmCommand, ["install", tarballPath], {
      cwd: packageInstallRoot,
      stdout: "inherit",
      stderr: "inherit"
    });
  });

  const hagiscriptCommand = binCommand(packageInstallRoot, "hagiscript");

  await tracker.run("installed binary execution", async () => {
    assertExecutableResolution(npmCommand, "npm");
    assertExecutableResolution(hagiscriptCommand, "hagiscript");
    await run(hagiscriptCommand, ["--version"], packageInstallRoot);
    await run(hagiscriptCommand, ["info"], packageInstallRoot);
  });

  await tracker.run("shell command execution", async () => {
    const { stdout } = await execa(process.execPath, ["-e", "console.log(process.argv[1])", "hagiscript-shell-check"], {
      cwd: packageInstallRoot,
      stdout: "pipe",
      env: integrationEnv()
    });
    assertIncludes(stdout, "hagiscript-shell-check", "shell-safe argument execution output");
  });

  await tracker.run("runtime install", async () => {
    log(`Installing Node.js into custom path ${runtimePath}`);
    const installNodeOutput = await runCapture(
      hagiscriptCommand,
      ["install-node", "--target", runtimePath],
      packageInstallRoot
    );
    process.stdout.write(installNodeOutput);
    assertIncludes(
      installNodeOutput,
      "Node.js runtime installed successfully.",
      "install-node success output"
    );
  });

  const runtimeNpm = await tracker.run("runtime check", async () => {
    const checkNodeOutput = await runCapture(
      hagiscriptCommand,
      ["check-node", "--target", runtimePath],
      packageInstallRoot
    );
    process.stdout.write(checkNodeOutput);
    assertIncludes(
      checkNodeOutput,
      "Node.js runtime is valid.",
      "check-node validation output"
    );

    const resolvedRuntimeNpm = extractRuntimeNpmPath(checkNodeOutput);
    assertExecutableResolution(runtimeNodeCommand(runtimePath), "managed node");
    assertExecutableResolution(resolvedRuntimeNpm, "managed npm");
    assertExpectedRuntimeNpmPath(resolvedRuntimeNpm, runtimeNpmCommand(runtimePath));

    const { stdout: runtimeGlobalRootOutput } = await execa(resolvedRuntimeNpm, ["root", "-g"], {
      cwd: packageInstallRoot,
      stdout: "pipe",
      env: integrationEnv(runtimePath)
    });
    const runtimeGlobalRoot = runtimeGlobalRootOutput.trim();

    if (!path.resolve(runtimeGlobalRoot).startsWith(path.resolve(runtimePath))) {
      throw new Error(
        `Expected npm global root to be inside custom runtime. Root: ${runtimeGlobalRoot}`
      );
    }

    return resolvedRuntimeNpm;
  });

  await tracker.run("platform-specific checks", async () => {
    await verifyPermissionBehavior(tempRoot, tracker);
    await verifySymlinkBehavior(tempRoot, tracker);
  });

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        packages: {
          "@openai/codex": {
            version: ">=0.0.0",
            target: "latest"
          }
        }
      },
      null,
      2
    )}\n`
  );

  await tracker.run("npm-sync", async () => {
    log("Running npm-sync against the custom runtime");
    const npmSyncOutput = await runCapture(
      hagiscriptCommand,
      [
        "npm-sync",
        "--runtime",
        runtimePath,
        "--manifest",
        manifestPath,
        "--registry-mirror",
        registryMirror
      ],
      packageInstallRoot
    );
    process.stdout.write(npmSyncOutput);
    assertIncludes(
      npmSyncOutput,
      "Manifest validated:",
      "npm-sync manifest output"
    );
    assertIncludes(
      npmSyncOutput,
      "Runtime validated:",
      "npm-sync runtime output"
    );
    assertIncludes(
      npmSyncOutput,
      `Registry mirror: ${registryMirror}`,
      "npm-sync registry mirror output"
    );
    assertIncludes(
      npmSyncOutput,
      "Plan: @openai/codex install",
      "npm-sync plan output"
    );
    assertIncludes(npmSyncOutput, "Changed: 1", "npm-sync summary output");

    const { stdout: inventoryOutput } = await execa(
      runtimeNpm,
      ["list", "-g", "--depth=0", "--json"],
      {
        cwd: packageInstallRoot,
        stdout: "pipe",
        env: integrationEnv(runtimePath)
      }
    );
    const inventory = JSON.parse(inventoryOutput);
    const installedVersion = inventory.dependencies?.["@openai/codex"]?.version;

    if (!installedVersion) {
      throw new Error(
        "Expected custom runtime to contain @openai/codex installed by npm-sync."
      );
    }
  });

  await tracker.run("npm-sync invalid manifest", async () => {
    fs.writeFileSync(
      invalidManifestPath,
      `${JSON.stringify(
        {
          packages: {
            "invalid package name": {
              version: "7.0.0"
            }
          }
        },
        null,
        2
      )}\n`
    );

    log("Verifying npm-sync failure diagnostics");
    const invalidOutput = await runExpectFailure(
      hagiscriptCommand,
      [
        "npm-sync",
        "--runtime",
        runtimePath,
        "--manifest",
        invalidManifestPath,
        "--registry-mirror",
        registryMirror
      ],
      packageInstallRoot
    );
    process.stdout.write(invalidOutput);
    assertIncludes(
      invalidOutput,
      "Manifest validation failed:",
      "npm-sync invalid manifest diagnostics"
    );
  });

  finalResult = "passed";
  log("Installed-package custom-runtime integration test passed");
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
  };
  const summary = formatIntegrationSummary({
    diagnostics: fallbackDiagnostics,
    stages: tracker.stages,
    skipped: tracker.skipped,
    finalResult
  });
  fs.writeFileSync(summaryPath, summary);
  process.stdout.write(`\n${summary}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}`);
  }

  if (process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH) {
    fs.mkdirSync(path.dirname(process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH), {
      recursive: true
    });
    fs.copyFileSync(summaryPath, process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH);
  }

  if (process.env.HAGISCRIPT_KEEP_INTEGRATION_TEMP !== "1") {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } else {
    log(`Keeping integration temp directory: ${tempRoot}`);
  }
}

async function run(command, args, cwd) {
  await execa(command, args, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: integrationEnv()
  });
}

async function runCapture(command, args, cwd) {
  const { stdout } = await execa(command, args, {
    cwd,
    stdout: "pipe",
    env: integrationEnv()
  });

  return stdout;
}

async function runExpectFailure(command, args, cwd) {
  try {
    await execa(command, args, {
      cwd,
      env: integrationEnv(),
      stdout: "pipe",
      stderr: "pipe"
    });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  throw new Error(`Expected command to fail: ${command} ${args.join(" ")}`);
}

function integrationEnv(npmPrefix) {
  const env = { ...process.env };
  delete env.PREFIX;
  delete env.NPM_CONFIG_PREFIX;
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_GLOBALCONFIG;
  delete env.npm_config_globalconfig;
  delete env.NPM_CONFIG_USERCONFIG;
  delete env.npm_config_userconfig;

  const nextEnv = {
    ...env,
    npm_config_fund: "false",
    npm_config_audit: "false"
  };

  if (npmPrefix) {
    nextEnv.NPM_CONFIG_PREFIX = npmPrefix;
  }

  return nextEnv;
}

function extractRuntimeNpmPath(output) {
  const npmLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith("npm: ") && line.includes(path.sep));

  if (!npmLine) {
    throw new Error(
      `Unable to find npm executable path in check-node output:\n${output}`
    );
  }

  return npmLine.slice("npm: ".length).trim();
}

function assertIncludes(output, expected, label) {
  if (!output.includes(expected)) {
    throw new Error(
      `Expected ${label} to include ${expected}. Output:\n${output}`
    );
  }
}

function assertExecutableResolution(command, label) {
  const basename = path.basename(command).toLowerCase();

  if (process.platform === "win32") {
    if (label === "managed node") {
      assertPathEndsWith(basename, "node.exe", label);
      return;
    }

    assertPathEndsWith(basename, ".cmd", label);
    return;
  }

  if (basename.endsWith(".cmd") || basename.endsWith(".exe")) {
    throw new Error(`Expected ${label} to resolve without Windows suffix: ${command}`);
  }
}

function assertExpectedRuntimeNpmPath(actual, expected) {
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`Expected managed npm path ${expected}, got ${actual}`);
  }
}

function assertPathEndsWith(value, expected, label) {
  if (!value.endsWith(expected)) {
    throw new Error(`Expected ${label} to end with ${expected}, got ${value}`);
  }
}

async function verifyPermissionBehavior(root, stageTracker) {
  const target = path.join(root, "permission-check.txt");
  fs.writeFileSync(target, "permission check\n");

  if (process.platform === "win32") {
    stageTracker.skip(
      "unix permission bits",
      "Windows runners do not expose POSIX mode-bit execution semantics"
    );
    return;
  }

  fs.chmodSync(target, 0o600);
  const mode = fs.statSync(target).mode & 0o777;

  if (mode !== 0o600) {
    throw new Error(`Expected chmod 0600 to be preserved, got ${mode.toString(8)}`);
  }

  fs.chmodSync(target, 0o700);
  const executableMode = fs.statSync(target).mode & 0o111;

  if (executableMode === 0) {
    throw new Error("Expected chmod 0700 to set at least one executable bit");
  }
}

async function verifySymlinkBehavior(root, stageTracker) {
  const target = path.join(root, "symlink-target.txt");
  const link = path.join(root, "symlink-link.txt");
  fs.writeFileSync(target, "symlink target\n");

  try {
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    if (process.platform === "win32") {
      stageTracker.skip(
        "symlink creation",
        `Windows runner privilege does not allow symlink creation: ${error.code ?? error.message}`
      );
      return;
    }

    throw error;
  }

  const resolved = fs.realpathSync(link);

  if (resolved !== fs.realpathSync(target)) {
    throw new Error(`Expected symlink ${link} to resolve to ${target}, got ${resolved}`);
  }
}

function log(message) {
  for (const line of message.split(/\r?\n/u)) {
    process.stdout.write(`[installed-runtime-integration] ${line}\n`);
  }
}
