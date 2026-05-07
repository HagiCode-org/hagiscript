#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  buildDevVersion,
  resolveDevelopmentBaseVersion
} from "./release-versioning.mjs";

const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const explicitTagName = process.argv[3] ?? process.env.NEXT_RELEASE_TAG_NAME;
const baseVersion = await resolveDevelopmentBaseVersion({
  packageVersion: packageJson.version,
  explicitTagName,
  requireUnreleasedTag: process.env.HAGISCRIPT_REQUIRE_UNRELEASED_TAG === "1"
});
const devVersion = buildDevVersion(baseVersion);

process.stdout.write(devVersion);
