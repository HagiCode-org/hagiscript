import { readFileSync } from "node:fs";

export interface PackageMetadata {
  name: string;
  version: string;
}

function loadPackageMetadata(): PackageMetadata {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };

  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    throw new Error("package.json must define a non-empty string name.");
  }

  if (
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error("package.json must define a non-empty string version.");
  }

  return {
    name: packageJson.name,
    version: packageJson.version
  };
}

const packageMetadata = loadPackageMetadata();

export const packageName = packageMetadata.name;
export const packageVersion = packageMetadata.version;

export function getPackageMetadata(): PackageMetadata {
  return { ...packageMetadata };
}
