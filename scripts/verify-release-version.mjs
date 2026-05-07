#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  compareStableVersions,
  extractStableVersionFromTag,
  parseStableVersion
} from "./release-versioning.mjs";

function getTagName() {
  const explicitTag =
    process.argv[2] ??
    process.env.RELEASE_TAG_NAME ??
    process.env.GITHUB_REF_NAME;
  if (explicitTag) {
    return explicitTag;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return undefined;
  }

  try {
    const eventPayload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    return eventPayload?.release?.tag_name;
  } catch {
    return undefined;
  }
}

const tagName = getTagName();

if (!tagName) {
  throw new Error(
    "Missing release tag. Pass a tag name or set GITHUB_REF_NAME."
  );
}

const expectedVersion = extractStableVersionFromTag(tagName);
const packageJsonPath = path.resolve(process.argv[3] ?? "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const packageBaseVersion = parseStableVersion(packageJson.version, "package version");

if (compareStableVersions(packageBaseVersion, expectedVersion) > 0) {
  throw new Error(
    `Tag ${tagName} is older than package.json version ${packageJson.version}.`
  );
}

process.stdout.write(expectedVersion);
