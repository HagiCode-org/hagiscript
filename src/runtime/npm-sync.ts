import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import semver from "semver";
import {
  installGlobalPackage,
  listGlobalPackages,
  NpmCommandError,
  type NpmCommandResult,
  type NpmGlobalCommandOptions
} from "./npm-global.js";
import { verifyNodeRuntime } from "./node-verify.js";

export interface NpmSyncManifestEntry {
  version: string;
  target?: string;
}

export interface NpmSyncManifest {
  packages: Record<string, NpmSyncManifestEntry>;
}

export type InstalledGlobalPackages = Record<string, string>;

export type NpmSyncActionKind =
  | "noop"
  | "install"
  | "upgrade"
  | "downgrade"
  | "sync";

export interface NpmSyncPlannedAction {
  packageName: string;
  requiredRange: string;
  targetSelector: string;
  selectedInstallSelector: string;
  installedVersion?: string;
  action: NpmSyncActionKind;
}

export interface NpmSyncActionResult extends NpmSyncPlannedAction {
  changed: boolean;
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
}

export interface NpmSyncRuntimeMetadata {
  targetDirectory: string;
  nodePath: string;
  npmPath: string;
  nodeVersion: string;
  npmVersion: string;
}

export interface NpmSyncSummary {
  runtime: NpmSyncRuntimeMetadata;
  manifestPath: string;
  packageCount: number;
  noopCount: number;
  changedCount: number;
  actions: NpmSyncActionResult[];
}

export interface NpmSyncOptions {
  runtimePath: string;
  manifestPath: string;
  npmOptions?: NpmGlobalCommandOptions;
  verifyRuntime?: typeof verifyNodeRuntime;
  onLog?: (event: NpmSyncLogEvent) => void;
}

export type NpmSyncLogEvent =
  | { type: "manifest-loaded"; manifestPath: string; packageCount: number }
  | { type: "runtime-valid"; runtime: NpmSyncRuntimeMetadata }
  | { type: "inventory"; packages: InstalledGlobalPackages }
  | { type: "planned-action"; action: NpmSyncPlannedAction }
  | { type: "skip"; action: NpmSyncPlannedAction }
  | { type: "install-start"; action: NpmSyncPlannedAction }
  | { type: "install-complete"; action: NpmSyncActionResult }
  | { type: "summary"; summary: NpmSyncSummary };

export class NpmSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpmSyncError";
  }
}

export class NpmManifestValidationError extends NpmSyncError {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Manifest validation failed: ${errors.join("; ")}`);
    this.name = "NpmManifestValidationError";
    this.errors = errors;
  }
}

export class NpmSyncCommandError extends NpmSyncError {
  readonly packageName?: string;
  readonly command: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, error: NpmCommandError, packageName?: string) {
    super(message);
    this.name = "NpmSyncCommandError";
    this.packageName = packageName;
    this.command = error.context.command;
    this.args = error.context.args;
    this.stdout = error.context.stdout;
    this.stderr = error.context.stderr;
  }
}

export async function loadNpmSyncManifest(
  manifestPath: string
): Promise<NpmSyncManifest> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NpmSyncError(
      `Failed to read manifest ${manifestPath}: ${message}`
    );
  }

  return validateNpmSyncManifest(parsed);
}

export function validateNpmSyncManifest(value: unknown): NpmSyncManifest {
  const errors: string[] = [];

  if (!isRecord(value)) {
    throw new NpmManifestValidationError(["manifest must be a JSON object"]);
  }

  if (!isRecord(value.packages) || Array.isArray(value.packages)) {
    throw new NpmManifestValidationError([
      "manifest must contain a top-level packages object"
    ]);
  }

  const packages: Record<string, NpmSyncManifestEntry> = {};

  for (const [packageName, entry] of Object.entries(value.packages)) {
    if (!isValidPackageName(packageName)) {
      errors.push(`invalid package name: ${packageName}`);
      continue;
    }

    if (!isRecord(entry) || Array.isArray(entry)) {
      errors.push(`${packageName} must be an object with a version range`);
      continue;
    }

    const version = entry.version;
    if (typeof version !== "string" || version.trim().length === 0) {
      errors.push(`${packageName}.version must be a non-empty semver range`);
      continue;
    }

    const normalizedRange = version.trim();
    if (!semver.validRange(normalizedRange)) {
      errors.push(
        `${packageName}.version is not a valid semver range: ${version}`
      );
      continue;
    }

    const target = entry.target;
    if (target !== undefined) {
      if (typeof target !== "string" || target.trim().length === 0) {
        errors.push(`${packageName}.target must be a non-empty npm selector`);
        continue;
      }

      packages[packageName] = {
        version: normalizedRange,
        target: target.trim()
      };
      continue;
    }

    packages[packageName] = { version: normalizedRange };
  }

  if (errors.length > 0) {
    throw new NpmManifestValidationError(errors);
  }

  return { packages };
}

export function normalizeGlobalInventory(
  stdout: string
): InstalledGlobalPackages {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NpmSyncError(`Failed to parse npm inventory JSON: ${message}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.dependencies)) {
    return {};
  }

  const installed: InstalledGlobalPackages = {};

  for (const [packageName, dependency] of Object.entries(parsed.dependencies)) {
    if (!isRecord(dependency) || typeof dependency.version !== "string") {
      continue;
    }

    installed[packageName] = dependency.version;
  }

  return installed;
}

export function createNpmSyncPlan(
  manifest: NpmSyncManifest,
  installed: InstalledGlobalPackages
): NpmSyncPlannedAction[] {
  return Object.entries(manifest.packages)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, entry]) => {
      const installedVersion = installed[packageName];
      const targetSelector = entry.target ?? entry.version;
      const selectedInstallSelector = `${packageName}@${targetSelector}`;

      if (!installedVersion) {
        return {
          packageName,
          requiredRange: entry.version,
          targetSelector,
          selectedInstallSelector,
          action: "install"
        };
      }

      if (
        semver.satisfies(installedVersion, entry.version, {
          includePrerelease: true
        })
      ) {
        return {
          packageName,
          requiredRange: entry.version,
          targetSelector,
          selectedInstallSelector,
          installedVersion,
          action: "noop"
        };
      }

      return {
        packageName,
        requiredRange: entry.version,
        targetSelector,
        selectedInstallSelector,
        installedVersion,
        action: classifyOutOfRangeVersion(installedVersion, entry.version)
      };
    });
}

export async function syncNpmGlobals(
  options: NpmSyncOptions
): Promise<NpmSyncSummary> {
  const manifest = await loadNpmSyncManifest(options.manifestPath);
  options.onLog?.({
    type: "manifest-loaded",
    manifestPath: options.manifestPath,
    packageCount: Object.keys(manifest.packages).length
  });

  const verifyRuntime = options.verifyRuntime ?? verifyNodeRuntime;
  const runtimeResult = await verifyRuntime(options.runtimePath);
  if (
    !runtimeResult.valid ||
    !runtimeResult.nodePath ||
    !runtimeResult.npmPath
  ) {
    throw new NpmSyncError(
      `Invalid Node.js runtime ${options.runtimePath}: ${runtimeResult.failureReason ?? "node/npm validation failed"}`
    );
  }

  const runtime: NpmSyncRuntimeMetadata = {
    targetDirectory: runtimeResult.targetDirectory,
    nodePath: runtimeResult.nodePath,
    npmPath: runtimeResult.npmPath,
    nodeVersion: runtimeResult.nodeVersion ?? "unknown",
    npmVersion: runtimeResult.npmVersion ?? "unknown"
  };
  options.onLog?.({ type: "runtime-valid", runtime });
  const npmOptions = {
    ...options.npmOptions,
    env: createRuntimeNpmEnv(runtime.targetDirectory, options.npmOptions?.env)
  };

  let inventoryResult: NpmCommandResult;
  try {
    inventoryResult = await listGlobalPackages(runtime.npmPath, npmOptions);
  } catch (error) {
    if (error instanceof NpmCommandError) {
      throw new NpmSyncCommandError(
        "Failed to list npm global packages",
        error
      );
    }
    throw error;
  }

  const installed = normalizeGlobalInventory(inventoryResult.stdout);
  options.onLog?.({ type: "inventory", packages: installed });

  const plan = createNpmSyncPlan(manifest, installed);
  const actions: NpmSyncActionResult[] = [];

  for (const action of plan) {
    options.onLog?.({ type: "planned-action", action });

    if (action.action === "noop") {
      const result: NpmSyncActionResult = { ...action, changed: false };
      actions.push(result);
      options.onLog?.({ type: "skip", action });
      continue;
    }

    options.onLog?.({ type: "install-start", action });
    try {
      const installResult = await installGlobalPackage(
        runtime.npmPath,
        action.selectedInstallSelector,
        npmOptions
      );
      const result: NpmSyncActionResult = {
        ...action,
        changed: true,
        command: installResult.command,
        args: installResult.args,
        stdout: installResult.stdout,
        stderr: installResult.stderr
      };
      actions.push(result);
      options.onLog?.({ type: "install-complete", action: result });
    } catch (error) {
      if (error instanceof NpmCommandError) {
        throw new NpmSyncCommandError(
          `Failed to sync package ${action.packageName}`,
          error,
          action.packageName
        );
      }
      throw error;
    }
  }

  const summary: NpmSyncSummary = {
    runtime,
    manifestPath: options.manifestPath,
    packageCount: plan.length,
    noopCount: actions.filter((action) => !action.changed).length,
    changedCount: actions.filter((action) => action.changed).length,
    actions
  };
  options.onLog?.({ type: "summary", summary });

  return summary;
}

function createRuntimeNpmEnv(
  runtimePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.PREFIX;
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_GLOBALCONFIG;
  delete env.npm_config_globalconfig;
  delete env.NPM_CONFIG_USERCONFIG;
  delete env.npm_config_userconfig;

  return {
    ...env,
    NPM_CONFIG_PREFIX: runtimePath,
    npm_config_fund: "false",
    npm_config_audit: "false"
  };
}

function classifyOutOfRangeVersion(
  installedVersion: string,
  range: string
): Exclude<NpmSyncActionKind, "noop" | "install"> {
  const minimum = semver.minVersion(range);
  if (minimum && semver.lt(installedVersion, minimum)) {
    return "upgrade";
  }

  if (isAboveAllowedRange(installedVersion, range)) {
    return "downgrade";
  }

  return "sync";
}

function isAboveAllowedRange(version: string, range: string): boolean {
  const parsed = new semver.Range(range, { includePrerelease: true });

  return parsed.set.every((comparators) =>
    comparators.some(
      (comparator) =>
        (comparator.operator === "<" || comparator.operator === "<=") &&
        semver.gt(version, comparator.semver.version)
    )
  );
}

function isValidPackageName(packageName: string): boolean {
  if (packageName.trim() !== packageName || packageName.length === 0) {
    return false;
  }

  if (packageName.includes("\\") || packageName.includes("/../")) {
    return false;
  }

  if (packageName.startsWith("@")) {
    const parts = packageName.split("/");
    return (
      parts.length === 2 &&
      parts[0].startsWith("@") &&
      isValidPackageNamePart(parts[0].slice(1)) &&
      isValidPackageNamePart(parts[1])
    );
  }

  return !packageName.includes("/") && isValidPackageNamePart(packageName);
}

function isValidPackageNamePart(value: string): boolean {
  return (
    value.length > 0 &&
    value === basename(value) &&
    !value.startsWith(".") &&
    !/[\s@]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
