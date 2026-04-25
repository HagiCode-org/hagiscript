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
const runNumber = process.env.GITHUB_RUN_NUMBER ?? "0";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
const shortSha = (process.env.GITHUB_SHA ?? "local")
  .toLowerCase()
  .replace(/[^0-9a-z]+/g, "")
  .slice(0, 7);

if (!/^\d+$/.test(runNumber)) {
  throw new Error(`GITHUB_RUN_NUMBER must be numeric. Received: ${runNumber}`);
}

if (!/^\d+$/.test(runAttempt)) {
  throw new Error(
    `GITHUB_RUN_ATTEMPT must be numeric. Received: ${runAttempt}`
  );
}

if (shortSha.length === 0) {
  throw new Error(
    "GITHUB_SHA must contain at least one alphanumeric character."
  );
}

const devVersion = `${baseVersion}-dev.${runNumber}.${runAttempt}.${shortSha}`;

process.stdout.write(devVersion);
