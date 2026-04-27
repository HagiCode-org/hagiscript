#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execa } from "execa";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hagiscript-it-"));
const packageInstallRoot = path.join(tempRoot, "installed-package");
const runtimePath = path.join(tempRoot, "custom-node-runtime");
const manifestPath = path.join(tempRoot, "manifest.json");
const invalidManifestPath = path.join(tempRoot, "invalid-manifest.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const registryMirror =
  process.env.HAGISCRIPT_INTEGRATION_REGISTRY_MIRROR?.trim() ||
  "https://registry.npmmirror.com/";

try {
  fs.mkdirSync(packageInstallRoot, { recursive: true });

  log("Packing current build artifact");
  const { stdout: packOutput } = await execa(
    npmCommand,
    ["pack", "--json", "--pack-destination", tempRoot],
    { cwd: repoRoot, stdout: "pipe" }
  );
  const [packSummary] = JSON.parse(packOutput);
  const tarballPath = path.join(tempRoot, packSummary.filename);

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

  const hagiscriptCommand = path.join(
    packageInstallRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "hagiscript.cmd" : "hagiscript"
  );
  await run(hagiscriptCommand, ["--version"], packageInstallRoot);
  await run(hagiscriptCommand, ["info"], packageInstallRoot);

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
  const runtimeNpm = extractRuntimeNpmPath(checkNodeOutput);
  const { stdout: runtimeGlobalRootOutput } = await execa(runtimeNpm, ["root", "-g"], {
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

  log("Installed-package custom-runtime integration test passed");
} finally {
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

function log(message) {
  process.stdout.write(`[installed-runtime-integration] ${message}\n`);
}
