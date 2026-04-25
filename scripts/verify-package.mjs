#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const binPath = packageJson.bin?.hagiscript;

if (!binPath) {
  throw new Error("package.json must define bin.hagiscript before publishing.");
}

const resolvedBinPath = path.join(repoRoot, binPath);
if (!fs.existsSync(resolvedBinPath)) {
  throw new Error(`Missing built CLI entrypoint: ${binPath}`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const output = execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8"
});
const [packSummary] = JSON.parse(output);
const packedFiles = new Set(
  (packSummary?.files ?? []).map((file) => file.path)
);
const requiredFiles = [
  "package.json",
  "README.md",
  "README_cn.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/index.js.map",
  "dist/cli.js",
  "dist/cli.d.ts",
  "dist/cli.js.map"
];
const forbiddenPatterns = [
  /^src\//,
  /^scripts\//,
  /^coverage\//,
  /^\.tmp\//,
  /^\.vitest-temp\//,
  /\.test\.ts$/
];

const missingFiles = requiredFiles.filter((file) => !packedFiles.has(file));
if (missingFiles.length > 0) {
  throw new Error(
    `npm pack is missing required publish files: ${missingFiles.join(", ")}`
  );
}

const forbiddenFiles = [...packedFiles].filter((file) =>
  forbiddenPatterns.some((pattern) => pattern.test(file))
);
if (forbiddenFiles.length > 0) {
  throw new Error(
    `npm pack includes source-only or local files: ${forbiddenFiles.join(", ")}`
  );
}

process.stdout.write(
  `Verified ${packSummary.name} with ${packSummary.files.length} packed files.\n`
);
