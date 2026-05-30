#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const rootPackageJsonPath = path.join(repoRoot, "package.json");
const sdkPackageJsonPath = path.join(repoRoot, "sdk", "package.json");

const rootPackageJson = JSON.parse(
  fs.readFileSync(rootPackageJsonPath, "utf8")
);
const sdkPackageJson = JSON.parse(fs.readFileSync(sdkPackageJsonPath, "utf8"));

if (typeof rootPackageJson.version !== "string" || rootPackageJson.version.length === 0) {
  throw new Error("Root package.json must define a non-empty version string.");
}

sdkPackageJson.version = rootPackageJson.version;

fs.writeFileSync(
  sdkPackageJsonPath,
  `${JSON.stringify(sdkPackageJson, null, 2)}\n`,
  "utf8"
);

process.stdout.write(`${rootPackageJson.version}\n`);
