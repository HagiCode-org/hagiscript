import { mkdir, readFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import semver from "semver";
import {
  installGlobalPackage,
  listGlobalPackages,
  NpmCommandError,
  type NpmCommandFailureContext,
  type NpmCommandResult,
  type NpmGlobalCommandOptions
} from "./npm-global.js";
import { verifyNodeRuntime } from "./node-verify.js";
import {
  buildToolSyncPackageSet,
  ToolSyncCatalogValidationError,
  type CustomAgentCliToolInput,
  type ToolSyncGroupId,
  type ToolSyncPackageConstraint,
  type ToolSyncRequirement
} from "./tool-sync-catalog.js";

export interface NpmSyncManifestEntry {
  version: string;
  target?: string;
  toolId?: string;
  toolDisplayName?: string;
  toolGroup?: ToolSyncGroupId;
  toolRequirement?: ToolSyncRequirement;
}

export interface NpmSyncManifest {
  packages: Record<string, NpmSyncManifestEntry>;
  syncMode: "packages" | "tools";
  registryMirror?: string;
}

export interface NpmSyncToolManifestSelection {
  optionalAgentCliSyncEnabled?: boolean;
  selectedOptionalAgentCliIds?: string[];
  customAgentClis?: CustomAgentCliToolInput[];
}

export interface NpmSyncToolManifest {
  tools: NpmSyncToolManifestSelection;
  registryMirror?: string;
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
  toolId?: string;
  toolDisplayName?: string;
  toolGroup?: ToolSyncGroupId;
  toolRequirement?: ToolSyncRequirement;
}

export interface NpmSyncActionResult extends NpmSyncPlannedAction {
  changed: boolean;
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  fallback?: NpmSyncFallbackEvent;
}

export interface NpmSyncRuntimeMetadata {
  targetDirectory: string;
  nodePath: string;
  npmPath: string;
  nodeVersion: string;
  npmVersion: string;
}

export type NpmSyncFallbackPolicy = "auto" | "mirror-only";

export type NpmSyncCommandKind = "inventory" | "install";

export interface NpmSyncFallbackEvent {
  commandKind: NpmSyncCommandKind;
  packageName?: string;
  mirrorRegistry: string;
  fallbackRegistry: string;
  retrySucceeded: boolean;
}

export interface NpmSyncSummary {
  runtime: NpmSyncRuntimeMetadata;
  manifestPath: string;
  packageCount: number;
  syncMode: NpmSyncManifest["syncMode"];
  registryMirror?: string;
  fallbackPolicy: NpmSyncFallbackPolicy;
  fallbackUsed: boolean;
  fallbackEvents: NpmSyncFallbackEvent[];
  noopCount: number;
  changedCount: number;
  actions: NpmSyncActionResult[];
}

export interface NpmSyncOptions {
  runtimePath: string;
  manifestPath: string;
  registryMirror?: string;
  fallbackPolicy?: NpmSyncFallbackPolicy;
  force?: boolean;
  npmOptions?: NpmGlobalCommandOptions;
  verifyRuntime?: typeof verifyNodeRuntime;
  onLog?: (event: NpmSyncLogEvent) => void;
}

export interface NpmSyncPlanOptions {
  force?: boolean;
}

export type NpmSyncLogEvent =
  | {
      type: "manifest-loaded";
      manifestPath: string;
      packageCount: number;
      syncMode: NpmSyncManifest["syncMode"];
      registryMirror?: string;
    }
  | {
      type: "fallback-policy";
      fallbackPolicy: NpmSyncFallbackPolicy;
      registryMirror: string;
      fallbackRegistry?: string;
    }
  | { type: "fallback-used"; fallback: NpmSyncFallbackEvent }
  | { type: "mirror-only"; registryMirror: string }
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
  readonly fallbackPolicy: NpmSyncFallbackPolicy;
  readonly registryMirror?: string;
  readonly fallbackRegistry?: string;
  readonly fallbackAttempted: boolean;
  readonly command: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly mirrorContext?: NpmCommandFailureContext;
  readonly officialContext?: NpmCommandFailureContext;

  constructor(
    message: string,
    error: NpmCommandError,
    options: {
      packageName?: string;
      fallbackPolicy?: NpmSyncFallbackPolicy;
      registryMirror?: string;
      fallbackRegistry?: string;
      mirrorError?: NpmCommandError;
      officialError?: NpmCommandError;
    } = {}
  ) {
    super(message);
    this.name = "NpmSyncCommandError";
    this.packageName = options.packageName;
    this.fallbackPolicy = options.fallbackPolicy ?? "auto";
    this.registryMirror = options.registryMirror;
    this.fallbackRegistry = options.fallbackRegistry;
    this.fallbackAttempted = Boolean(options.officialError);
    this.command = error.context.command;
    this.args = error.context.args;
    this.stdout = error.context.stdout;
    this.stderr = error.context.stderr;
    this.mirrorContext = options.mirrorError?.context;
    this.officialContext = options.officialError?.context;
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

  const registryMirror = validateRegistryMirrorValue(
    value.registryMirror,
    "registryMirror",
    errors
  );

  if (isRecord(value.tools) && !Array.isArray(value.tools)) {
    return validateToolSyncManifest(value.tools, registryMirror, errors);
  }

  if (!isRecord(value.packages) || Array.isArray(value.packages)) {
    throw new NpmManifestValidationError([
      "manifest must contain a top-level packages object or tools object"
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

  return { packages, syncMode: "packages", registryMirror };
}

export function validateRegistryMirror(
  value: unknown,
  path = "registryMirror"
): string | undefined {
  const errors: string[] = [];
  const registryMirror = validateRegistryMirrorValue(value, path, errors);
  if (errors.length > 0) {
    throw new NpmManifestValidationError(errors);
  }

  return registryMirror;
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
  installed: InstalledGlobalPackages,
  options: NpmSyncPlanOptions = {}
): NpmSyncPlannedAction[] {
  const force = options.force ?? false;

  return Object.entries(manifest.packages)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, entry]) => {
      const installedVersion = installed[packageName];
      const targetSelector = entry.target ?? entry.version;
      const selectedInstallSelector = `${packageName}@${targetSelector}`;
      const metadata = createActionMetadata(entry);

      if (!installedVersion) {
        return {
          packageName,
          requiredRange: entry.version,
          targetSelector,
          selectedInstallSelector,
          action: "install",
          ...metadata
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
          action: force ? "sync" : "noop",
          ...metadata
        };
      }

      return {
        packageName,
        requiredRange: entry.version,
        targetSelector,
        selectedInstallSelector,
        installedVersion,
        action: classifyOutOfRangeVersion(installedVersion, entry.version),
        ...metadata
      };
    });
}

const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

interface MirrorAwareCommandExecution {
  result: NpmCommandResult;
  fallback?: NpmSyncFallbackEvent;
}

export async function syncNpmGlobals(
  options: NpmSyncOptions
): Promise<NpmSyncSummary> {
  const manifest = await loadNpmSyncManifest(options.manifestPath);
  const registryMirrorOverride = validateRegistryMirror(
    options.registryMirror,
    "--registry-mirror"
  );
  const registryMirror = registryMirrorOverride ?? manifest.registryMirror;
  const fallbackPolicy = normalizeFallbackPolicy(options.fallbackPolicy);
  options.onLog?.({
    type: "manifest-loaded",
    manifestPath: options.manifestPath,
    packageCount: Object.keys(manifest.packages).length,
    syncMode: manifest.syncMode,
    registryMirror
  });
  if (registryMirror) {
    options.onLog?.({
      type: "fallback-policy",
      fallbackPolicy,
      registryMirror,
      fallbackRegistry: OFFICIAL_NPM_REGISTRY
    });
    if (fallbackPolicy === "mirror-only") {
      options.onLog?.({ type: "mirror-only", registryMirror });
    }
  }

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
  await prepareNpmGlobalPrefix(npmOptions.prefix, npmOptions.platform);
  const fallbackEvents: NpmSyncFallbackEvent[] = [];

  const inventoryExecution = await executeMirrorAwareNpmCommand({
    commandKind: "inventory",
    message: "Failed to list npm global packages",
    npmOptions,
    registryMirror,
    fallbackPolicy,
    onLog: options.onLog,
    execute: (commandOptions) =>
      listGlobalPackages(runtime.npmPath, commandOptions)
  });
  const inventoryResult = inventoryExecution.result;
  if (inventoryExecution.fallback) {
    fallbackEvents.push(inventoryExecution.fallback);
  }

  const installed = normalizeGlobalInventory(inventoryResult.stdout);
  options.onLog?.({ type: "inventory", packages: installed });

  const plan = createNpmSyncPlan(manifest, installed, {
    force: options.force ?? false
  });
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
    const execution = await executeMirrorAwareNpmCommand({
      commandKind: "install",
      message: `Failed to sync package ${action.packageName}`,
      packageName: action.packageName,
      npmOptions,
      registryMirror,
      fallbackPolicy,
      onLog: options.onLog,
      execute: (commandOptions) =>
        installGlobalPackage(
          runtime.npmPath,
          action.selectedInstallSelector,
          commandOptions
        )
    });
    const installResult = execution.result;
    const result: NpmSyncActionResult = {
      ...action,
      changed: true,
      command: installResult.command,
      args: installResult.args,
      stdout: installResult.stdout,
      stderr: installResult.stderr,
      fallback: execution.fallback
    };
    actions.push(result);
    if (execution.fallback) {
      fallbackEvents.push(execution.fallback);
    }
    options.onLog?.({ type: "install-complete", action: result });
  }

  const summary: NpmSyncSummary = {
    runtime,
    manifestPath: options.manifestPath,
    packageCount: plan.length,
    syncMode: manifest.syncMode,
    registryMirror,
    fallbackPolicy,
    fallbackUsed: fallbackEvents.length > 0,
    fallbackEvents,
    noopCount: actions.filter((action) => !action.changed).length,
    changedCount: actions.filter((action) => action.changed).length,
    actions
  };
  options.onLog?.({ type: "summary", summary });

  return summary;
}

async function executeMirrorAwareNpmCommand(options: {
  commandKind: NpmSyncCommandKind;
  message: string;
  packageName?: string;
  npmOptions: NpmGlobalCommandOptions;
  registryMirror?: string;
  fallbackPolicy: NpmSyncFallbackPolicy;
  onLog?: (event: NpmSyncLogEvent) => void;
  execute: (
    commandOptions: NpmGlobalCommandOptions
  ) => Promise<NpmCommandResult>;
}): Promise<MirrorAwareCommandExecution> {
  const {
    commandKind,
    message,
    packageName,
    npmOptions,
    registryMirror,
    fallbackPolicy,
    onLog,
    execute
  } = options;

  try {
    return {
      result: await execute(withRegistryMirror(npmOptions, registryMirror))
    };
  } catch (error) {
    if (!(error instanceof NpmCommandError)) {
      throw error;
    }

    if (!registryMirror) {
      throw new NpmSyncCommandError(message, error, {
        packageName,
        fallbackPolicy
      });
    }

    if (fallbackPolicy === "mirror-only") {
      throw new NpmSyncCommandError(message, error, {
        packageName,
        fallbackPolicy,
        registryMirror,
        mirrorError: error
      });
    }

    try {
      const result = await execute(
        withRegistryMirror(npmOptions, OFFICIAL_NPM_REGISTRY)
      );
      const fallback: NpmSyncFallbackEvent = {
        commandKind,
        packageName,
        mirrorRegistry: registryMirror,
        fallbackRegistry: OFFICIAL_NPM_REGISTRY,
        retrySucceeded: true
      };
      onLog?.({ type: "fallback-used", fallback });
      return { result, fallback };
    } catch (fallbackError) {
      if (!(fallbackError instanceof NpmCommandError)) {
        throw fallbackError;
      }

      throw new NpmSyncCommandError(message, fallbackError, {
        packageName,
        fallbackPolicy,
        registryMirror,
        fallbackRegistry: OFFICIAL_NPM_REGISTRY,
        mirrorError: error,
        officialError: fallbackError
      });
    }
  }
}

function withRegistryMirror(
  options: NpmGlobalCommandOptions,
  registryMirror?: string
): NpmGlobalCommandOptions {
  if (!registryMirror) {
    return { ...options };
  }

  return { ...options, registryMirror };
}

function normalizeFallbackPolicy(
  value: NpmSyncOptions["fallbackPolicy"]
): NpmSyncFallbackPolicy {
  return value === "mirror-only" ? "mirror-only" : "auto";
}

async function prepareNpmGlobalPrefix(
  prefix: string | undefined,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (!prefix) {
    return;
  }

  const requiredDirectories =
    platform === "win32"
      ? [join(prefix, "node_modules")]
      : [join(prefix, "lib", "node_modules"), join(prefix, "bin")];

  await Promise.all(
    requiredDirectories.map((directory) =>
      mkdir(directory, { recursive: true })
    )
  );
}

function validateToolSyncManifest(
  value: Record<string, unknown>,
  registryMirror: string | undefined,
  existingErrors: readonly string[]
): NpmSyncManifest {
  if (existingErrors.length > 0) {
    throw new NpmManifestValidationError([...existingErrors]);
  }

  try {
    const selection = normalizeToolSelection(value);
    const packageSet = buildToolSyncPackageSet(selection);
    return {
      packages: normalizeToolPackageSet(packageSet),
      syncMode: "tools",
      registryMirror
    };
  } catch (error) {
    if (error instanceof ToolSyncCatalogValidationError) {
      throw new NpmManifestValidationError(error.errors);
    }
    throw error;
  }
}

function validateRegistryMirrorValue(
  value: unknown,
  path: string,
  errors: string[]
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    errors.push(`${path} must be a string URL`);
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${path} must be a non-empty URL`);
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    errors.push(`${path} must be an absolute http or https URL`);
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(`${path} must use http or https protocol`);
    return undefined;
  }

  return trimmed;
}

function normalizeToolSelection(
  value: Record<string, unknown>
): NpmSyncToolManifestSelection {
  const errors: string[] = [];
  const optionalAgentCliSyncEnabled = Boolean(
    value.optionalAgentCliSyncEnabled
  );
  const selectedOptionalAgentCliIds = normalizeStringArray(
    value.selectedOptionalAgentCliIds,
    "tools.selectedOptionalAgentCliIds",
    errors
  );
  const customAgentClis = normalizeCustomAgentCliArray(
    value.customAgentClis,
    errors
  );

  if (errors.length > 0) {
    throw new NpmManifestValidationError(errors);
  }

  return {
    optionalAgentCliSyncEnabled,
    selectedOptionalAgentCliIds,
    customAgentClis
  };
}

function normalizeStringArray(
  value: unknown,
  path: string,
  errors: string[]
): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings`);
    return [];
  }

  return value.flatMap((item, index) => {
    if (typeof item !== "string") {
      errors.push(`${path}[${index}] must be a string`);
      return [];
    }

    return [item];
  });
}

function normalizeCustomAgentCliArray(
  value: unknown,
  errors: string[]
): CustomAgentCliToolInput[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push("tools.customAgentClis must be an array");
    return [];
  }

  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      errors.push(`tools.customAgentClis[${index}] must be an object`);
      return [];
    }

    const input: CustomAgentCliToolInput = {
      packageName: typeof item.packageName === "string" ? item.packageName : ""
    };

    if (typeof item.id === "string") {
      input.id = item.id;
    }
    if (typeof item.displayName === "string") {
      input.displayName = item.displayName;
    }
    if (typeof item.version === "string") {
      input.version = item.version;
    }
    if (typeof item.target === "string") {
      input.target = item.target;
    }

    return [input];
  });
}

function normalizeToolPackageSet(
  packageSet: Record<string, ToolSyncPackageConstraint>
): Record<string, NpmSyncManifestEntry> {
  return Object.fromEntries(
    Object.entries(packageSet).map(([packageName, entry]) => [
      packageName,
      {
        version: entry.version,
        target: entry.target,
        toolId: entry.toolId,
        toolDisplayName: entry.toolDisplayName,
        toolGroup: entry.toolGroup,
        toolRequirement: entry.toolRequirement
      }
    ])
  );
}

function createActionMetadata(
  entry: NpmSyncManifestEntry
): Pick<
  NpmSyncPlannedAction,
  "toolId" | "toolDisplayName" | "toolGroup" | "toolRequirement"
> {
  return {
    toolId: entry.toolId,
    toolDisplayName: entry.toolDisplayName,
    toolGroup: entry.toolGroup,
    toolRequirement: entry.toolRequirement
  };
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
  const runtimeBinDirectory =
    process.platform === "win32" ? runtimePath : join(runtimePath, "bin");
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const existingPath =
    process.platform === "win32" ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");

  return {
    ...env,
    NPM_CONFIG_PREFIX: runtimePath,
    npm_config_prefix: runtimePath,
    [pathKey]: [runtimeBinDirectory, existingPath].filter(Boolean).join(delimiter),
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
