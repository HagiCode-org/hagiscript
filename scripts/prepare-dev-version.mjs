#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const match = String(packageJson.version).match(
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:[-+].*)?$/
);

if (!match?.groups) {
  throw new Error(`Unsupported package version: ${packageJson.version}`);
}

const baseVersion = `${match.groups.major}.${match.groups.minor}.${match.groups.patch}`;
const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "")
  .replace(/\.\d{3}Z$/, "");
const runNumber = process.env.GITHUB_RUN_NUMBER ?? "0";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "0";
const shortSha = (process.env.GITHUB_SHA ?? "local").slice(0, 7).toLowerCase();
const devVersion = `${baseVersion}-dev.${timestamp}.${runNumber}.${runAttempt}.${shortSha}`;

packageJson.version = devVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

process.stdout.write(devVersion);
