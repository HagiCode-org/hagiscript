#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { runProcess } from "./process-runner.mjs";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const sdkRoot = path.join(repoRoot, "sdk");
const sdkPackageJsonPath = path.join(sdkRoot, "package.json");

if (!fs.existsSync(sdkPackageJsonPath)) {
  throw new Error("sdk/package.json must exist before verifying the SDK package.");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const { stdout: output } = await runProcess(
  npmCommand,
  ["pack", "--dry-run", "--json"],
  {
    cwd: sdkRoot,
    stdout: "pipe"
  }
);
const [packSummary] = JSON.parse(output);
const packedFiles = new Set((packSummary?.files ?? []).map((file) => file.path));
const requiredFiles = ["dist/src/index.js", "dist/src/index.d.ts", "README.md"];
const forbiddenPatterns = [
  /^bin\//,
  /^commands\//,
  /^dist\/cli\./,
  /^dist\/commands\//,
  /^dist\/src\/cli\./,
  /^dist\/src\/commands\//,
  /(^|\/)cli\.js$/,
  /(^|\/)commands\//
];

const missingFiles = requiredFiles.filter((file) => !packedFiles.has(file));
if (missingFiles.length > 0) {
  throw new Error(
    `SDK npm pack is missing required publish files: ${missingFiles.join(", ")}`
  );
}

const forbiddenFiles = [...packedFiles].filter((file) =>
  forbiddenPatterns.some((pattern) => pattern.test(file))
);
if (forbiddenFiles.length > 0) {
  throw new Error(
    `SDK npm pack includes CLI artifacts: ${forbiddenFiles.join(", ")}`
  );
}

process.stdout.write(
  `Verified ${packSummary.name} with ${packSummary.files.length} packed files.\n`
);
