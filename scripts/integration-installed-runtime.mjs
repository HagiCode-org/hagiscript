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

  const hagiscriptCli = path.join(
    packageInstallRoot,
    "node_modules",
    "@hagicode",
    "hagiscript",
    "dist",
    "cli.js"
  );
  run(process.execPath, [hagiscriptCli, "--version"], packageInstallRoot);
  run(process.execPath, [hagiscriptCli, "info"], packageInstallRoot);

  log(`Installing Node.js into custom path ${runtimePath}`);
  run(
    process.execPath,
    [hagiscriptCli, "install-node", "--target", runtimePath],
    packageInstallRoot
  );
  const checkNodeOutput = runCapture(
    process.execPath,
    [hagiscriptCli, "check-node", "--target", runtimePath],
    packageInstallRoot
  );
  process.stdout.write(checkNodeOutput);
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
          "is-number": {
            version: "7.0.0"
          }
        }
      },
      null,
      2
    )}\n`
  );

  log("Running npm-sync against the custom runtime");
  run(
    process.execPath,
    [
      hagiscriptCli,
      "npm-sync",
      "--runtime",
      runtimePath,
      "--manifest",
      manifestPath
    ],
    packageInstallRoot
  );

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
  const installedVersion = inventory.dependencies?.["is-number"]?.version;

  if (installedVersion !== "7.0.0") {
    throw new Error(
      `Expected custom runtime to contain is-number@7.0.0, got ${installedVersion ?? "missing"}.`
    );
  }

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

function log(message) {
  process.stdout.write(`[installed-runtime-integration] ${message}\n`);
}
