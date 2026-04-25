#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

if (!tagName) {
  throw new Error(
    "Missing release tag. Pass a tag name or set GITHUB_REF_NAME."
  );
}

const match = String(tagName).match(
  /^v(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/
);

if (!match?.groups) {
  throw new Error(
    `Release tags must use the stable vX.Y.Z format. Received: ${tagName}`
  );
}

const expectedVersion = `${match.groups.major}.${match.groups.minor}.${match.groups.patch}`;
const packageJsonPath = path.resolve(process.argv[3] ?? "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const packageVersionMatch = String(packageJson.version).match(
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:[-+].*)?$/
);

if (!packageVersionMatch?.groups) {
  throw new Error(`Unsupported package version: ${packageJson.version}`);
}

const packageBaseVersion = `${packageVersionMatch.groups.major}.${packageVersionMatch.groups.minor}.${packageVersionMatch.groups.patch}`;

if (compareStableVersions(packageBaseVersion, expectedVersion) > 0) {
  throw new Error(
    `Tag ${tagName} is older than package.json version ${packageJson.version}.`
  );
}

process.stdout.write(expectedVersion);
