#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hagiscript-it-"));
const packageInstallRoot = path.join(tempRoot, "installed-package");
const runtimePath = path.join(tempRoot, "custom-node-runtime");
const manifestPath = path.join(tempRoot, "manifest.json");
const invalidManifestPath = path.join(tempRoot, "invalid-manifest.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  fs.mkdirSync(packageInstallRoot, { recursive: true });

  log("Packing current build artifact");
  const packOutput = execFileSync(
    npmCommand,
    ["pack", "--json", "--pack-destination", tempRoot],
    { cwd: repoRoot, encoding: "utf8" }
  );
  const [packSummary] = JSON.parse(packOutput);
  const tarballPath = path.join(tempRoot, packSummary.filename);

  log(`Installing packed package into ${packageInstallRoot}`);
  execFileSync(npmCommand, ["init", "-y"], {
    cwd: packageInstallRoot,
    stdio: "ignore"
  });
  execFileSync(npmCommand, ["install", tarballPath], {
    cwd: packageInstallRoot,
    stdio: "inherit"
  });

  const hagiscriptCommand = path.join(
    packageInstallRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "hagiscript.cmd" : "hagiscript"
  );
  run(hagiscriptCommand, ["--version"], packageInstallRoot);
  run(hagiscriptCommand, ["info"], packageInstallRoot);

  log(`Installing Node.js into custom path ${runtimePath}`);
  const installNodeOutput = runCapture(
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

  const checkNodeOutput = runCapture(
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
  const runtimeGlobalRoot = execFileSync(runtimeNpm, ["root", "-g"], {
    cwd: packageInstallRoot,
    encoding: "utf8",
    env: integrationEnv(runtimePath)
  }).trim();

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
  const npmSyncOutput = runCapture(
    hagiscriptCommand,
    ["npm-sync", "--runtime", runtimePath, "--manifest", manifestPath],
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
    "Plan: @openai/codex install",
    "npm-sync plan output"
  );
  assertIncludes(npmSyncOutput, "Changed: 1", "npm-sync summary output");

  const inventoryOutput = execFileSync(
    runtimeNpm,
    ["list", "-g", "--depth=0", "--json"],
    {
      cwd: packageInstallRoot,
      encoding: "utf8",
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
  const invalidOutput = runExpectFailure(
    hagiscriptCommand,
    ["npm-sync", "--runtime", runtimePath, "--manifest", invalidManifestPath],
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

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: integrationEnv()
  });
}

function runCapture(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: integrationEnv()
  });
}

function runExpectFailure(command, args, cwd) {
  try {
    execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: integrationEnv(),
      stdio: ["ignore", "pipe", "pipe"]
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
