#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execa } from "execa";

const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const packageName = String(packageJson.name ?? "");
const scopeMatch = packageName.match(/^@(?<scope>[^/]+)\//u);
const repositoryUrl = normalizeRepositoryUrl(packageJson.repository);
const expectedRepository = "github.com/HagiCode-org/hagiscript";
const workflowPath =
  process.env.GITHUB_WORKFLOW_REF?.split("@", 1)[0] ??
  "HagiCode-org/hagiscript/.github/workflows/npm-publish.yml";

if (!scopeMatch?.groups?.scope) {
  throw new Error(
    `Package name ${packageName} is unscoped. This preflight is intended for scoped npm packages.`
  );
}

const scope = scopeMatch.groups.scope;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

process.stdout.write(
  [
    `Package: ${packageName}`,
    `npm scope: @${scope}`,
    `Repository URL: ${repositoryUrl ?? "<missing>"}`,
    `GitHub repository: ${process.env.GITHUB_REPOSITORY ?? "HagiCode-org/hagiscript"}`,
    `GitHub workflow ref: ${process.env.GITHUB_WORKFLOW_REF ?? "<local>"}`,
    `Trusted publisher workflow path: ${workflowPath}`
  ].join("\n") + "\n"
);

if (!repositoryUrl?.includes(expectedRepository)) {
  throw new Error(
    `package.json repository.url must point to ${expectedRepository} for npm trusted publishing. Received: ${repositoryUrl ?? "<missing>"}`
  );
}

if (
  process.env.GITHUB_REPOSITORY &&
  process.env.GITHUB_REPOSITORY !== "HagiCode-org/hagiscript"
) {
  throw new Error(
    `This npm trusted publisher is expected to run from HagiCode-org/hagiscript. Received: ${process.env.GITHUB_REPOSITORY}`
  );
}

await runNpm(["ping", "--registry", "https://registry.npmjs.org"], {
  failureMessage: "Unable to reach https://registry.npmjs.org."
});

const scopeExists = await npmView(`@${scope}`);
if (!scopeExists) {
  process.stdout.write(
    [
      `npm scope @${scope} is not visible via npm view on https://registry.npmjs.org.`,
      "This can be normal before the first package exists because npm scopes are not package documents.",
      `Publish will still require an npm organization/user scope named '${scope}' with trusted publisher access for ${packageName}.`,
      "If the scope is missing or inaccessible, npm publish usually fails with E404 Not Found on PUT."
    ].join("\n") + "\n"
  );
}

const packageExists = await npmView(packageName);
if (!packageExists) {
  process.stdout.write(
    [
      `Package ${packageName} does not exist yet; npm publish will create it if the workflow identity has access to @${scope}.`,
      "For GitHub Actions trusted publishing, configure npm trusted publisher access for this repository before publishing.",
      "npm package: @hagicode/hagiscript",
      "GitHub owner: HagiCode-org",
      "GitHub repository: hagiscript",
      "Workflow filename: npm-publish.yml",
      "Workflow path: .github/workflows/npm-publish.yml",
      "Environment: leave empty unless the npm trusted publisher entry requires one."
    ].join("\n") + "\n"
  );
} else {
  process.stdout.write(`Package ${packageName} exists on npm.\n`);
}

process.stdout.write(
  `npm publish prerequisites look valid for ${packageName}.\n`
);

async function npmView(name) {
  try {
    await execa(
      npmCommand,
      ["view", name, "name", "--registry", "https://registry.npmjs.org"],
      {
        stdout: "ignore",
        stderr: "ignore"
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function runNpm(args, options) {
  try {
    await execa(npmCommand, args, { stdout: "inherit", stderr: "inherit" });
  } catch (error) {
    throw new Error(
      `${options.failureMessage}\n${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeRepositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string" || url.length === 0) {
    return undefined;
  }

  return url
    .replace(/^git\+/u, "")
    .replace(/^https?:\/\//u, "")
    .replace(/^git@github\.com:/u, "github.com/")
    .replace(/\.git$/u, "");
}
