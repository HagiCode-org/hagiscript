#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const packageName = String(packageJson.name ?? "");
const scopeMatch = packageName.match(/^@(?<scope>[^/]+)\//u);

if (!scopeMatch?.groups?.scope) {
  throw new Error(
    `Package name ${packageName} is unscoped. This preflight is intended for scoped npm packages.`
  );
}

const scope = scopeMatch.groups.scope;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

runNpm(["ping", "--registry", "https://registry.npmjs.org"], {
  failureMessage: "Unable to reach https://registry.npmjs.org."
});

const scopeExists = npmView(`@${scope}`);
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

const packageExists = npmView(packageName);
if (!packageExists) {
  process.stdout.write(
    [
      `Package ${packageName} does not exist yet; npm publish will create it if the workflow identity has access to @${scope}.`,
      "For GitHub Actions trusted publishing, configure npm trusted publisher access for this repository before publishing.",
      "Repository: HagiCode-org/hagiscript",
      "Workflow: .github/workflows/npm-publish.yml"
    ].join("\n") + "\n"
  );
} else {
  process.stdout.write(`Package ${packageName} exists on npm.\n`);
}

process.stdout.write(
  `npm publish prerequisites look valid for ${packageName}.\n`
);

function npmView(name) {
  try {
    execFileSync(
      npmCommand,
      ["view", name, "name", "--registry", "https://registry.npmjs.org"],
      {
        stdio: "ignore"
      }
    );
    return true;
  } catch {
    return false;
  }
}

function runNpm(args, options) {
  try {
    execFileSync(npmCommand, args, { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      `${options.failureMessage}\n${error instanceof Error ? error.message : String(error)}`
    );
  }
}
