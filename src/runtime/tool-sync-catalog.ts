import { basename } from "node:path";
import semver from "semver";
import toolSyncCatalogConfig from "./tool-sync-catalog.config.json" with { type: "json" };

export type ToolSyncGroupId = "mandatory" | "optional-agent-cli";
export type ToolSyncRequirement = "mandatory" | "optional";

export interface ToolSyncCatalogEntry {
  id: string;
  displayName: string;
  packageName: string;
  version: string;
  target?: string;
  group: ToolSyncGroupId;
  requirement: ToolSyncRequirement;
}

export interface ToolSyncPackageConstraint {
  version: string;
  target?: string;
  toolId: string;
  toolDisplayName: string;
  toolGroup: ToolSyncGroupId;
  toolRequirement: ToolSyncRequirement;
}

export interface CustomAgentCliToolInput {
  id?: string;
  displayName?: string;
  packageName: string;
  version?: string;
  target?: string;
}

export interface ToolSyncSelection {
  optionalAgentCliSyncEnabled?: boolean;
  selectedOptionalAgentCliIds?: string[];
  customAgentClis?: CustomAgentCliToolInput[];
}

export interface BuildToolSyncPackageSetOptions extends ToolSyncSelection {
  catalog?: readonly ToolSyncCatalogEntry[];
}

interface ToolSyncCatalogConfig {
  schemaVersion: number;
  tools: ToolSyncCatalogEntry[];
}

export class ToolSyncCatalogValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Tool sync catalog validation failed: ${errors.join("; ")}`);
    this.name = "ToolSyncCatalogValidationError";
    this.errors = errors;
  }
}

export const builtInToolSyncCatalogConfig =
  toolSyncCatalogConfig as ToolSyncCatalogConfig;

export const builtInToolSyncCatalog: readonly ToolSyncCatalogEntry[] =
  builtInToolSyncCatalogConfig.tools;

export function validateToolSyncCatalog(
  catalog: readonly ToolSyncCatalogEntry[] = builtInToolSyncCatalog
): readonly ToolSyncCatalogEntry[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenMandatory = new Set<string>();

  for (const entry of catalog) {
    validateCatalogEntry(entry, errors);

    if (seenIds.has(entry.id)) {
      errors.push(`duplicate tool ID: ${entry.id}`);
    }
    seenIds.add(entry.id);

    if (entry.requirement === "mandatory") {
      seenMandatory.add(entry.id);
    }
  }

  for (const requiredId of ["openspec-skills", "omniroute", "code-server"]) {
    if (!seenMandatory.has(requiredId)) {
      errors.push(`missing mandatory tool: ${requiredId}`);
    }
  }

  if (errors.length > 0) {
    throw new ToolSyncCatalogValidationError(errors);
  }

  return catalog;
}

export function buildToolSyncPackageSet(
  options: BuildToolSyncPackageSetOptions = {}
): Record<string, ToolSyncPackageConstraint> {
  const catalog = validateToolSyncCatalog(
    options.catalog ?? builtInToolSyncCatalog
  );
  const errors: string[] = [];
  const packages: Record<string, ToolSyncPackageConstraint> = {};
  const optionalEntries = catalog.filter(
    (entry) => entry.group === "optional-agent-cli"
  );
  const optionalById = new Map(optionalEntries.map((entry) => [entry.id, entry]));
  const selectedIds = normalizeSelectedIds(
    options.selectedOptionalAgentCliIds ?? []
  );
  const customEntries = normalizeCustomAgentCliTools(
    options.customAgentClis ?? [],
    errors
  );

  if (options.optionalAgentCliSyncEnabled) {
    for (const selectedId of selectedIds) {
      if (!optionalById.has(selectedId)) {
        errors.push(`unknown optional agent CLI tool ID: ${selectedId}`);
      }
    }
  } else if (selectedIds.length > 0 || customEntries.length > 0) {
    errors.push(
      "optional agent CLI sync must be enabled when optional CLI selections are provided"
    );
  }

  for (const entry of catalog) {
    if (entry.requirement !== "mandatory") {
      continue;
    }
    addPackageConstraint(packages, entry, errors);
  }

  if (options.optionalAgentCliSyncEnabled) {
    for (const selectedId of selectedIds) {
      const entry = optionalById.get(selectedId);
      if (entry) {
        addPackageConstraint(packages, entry, errors);
      }
    }

    for (const entry of customEntries) {
      addPackageConstraint(packages, entry, errors);
    }
  }

  if (errors.length > 0) {
    throw new ToolSyncCatalogValidationError(errors);
  }

  return Object.fromEntries(
    Object.entries(packages).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

export function normalizeToolSyncEntry(
  entry: ToolSyncCatalogEntry
): [string, ToolSyncPackageConstraint] {
  return [
    entry.packageName,
    {
      version: normalizeVersionSelector(entry.version),
      target: entry.target?.trim(),
      toolId: entry.id,
      toolDisplayName: entry.displayName,
      toolGroup: entry.group,
      toolRequirement: entry.requirement
    }
  ];
}

function addPackageConstraint(
  packages: Record<string, ToolSyncPackageConstraint>,
  entry: ToolSyncCatalogEntry,
  errors: string[]
): void {
  const [packageName, constraint] = normalizeToolSyncEntry(entry);
  const existing = packages[packageName];
  if (existing) {
    errors.push(
      `package ${packageName} is declared by both ${existing.toolId} and ${entry.id}`
    );
    return;
  }

  packages[packageName] = constraint;
}

function validateCatalogEntry(
  entry: ToolSyncCatalogEntry,
  errors: string[]
): void {
  if (!isValidToolId(entry.id)) {
    errors.push(`invalid tool ID: ${entry.id}`);
  }

  if (entry.displayName.trim().length === 0) {
    errors.push(`${entry.id}.displayName must be non-empty`);
  }

  if (!isValidPackageName(entry.packageName)) {
    errors.push(`${entry.id}.packageName is invalid: ${entry.packageName}`);
  }

  if (!isValidVersionSelector(entry.version)) {
    errors.push(`${entry.id}.version is invalid: ${entry.version}`);
  }

  if (entry.target !== undefined && entry.target.trim().length === 0) {
    errors.push(`${entry.id}.target must be non-empty when provided`);
  }

  if (entry.group === "mandatory" && entry.requirement !== "mandatory") {
    errors.push(`${entry.id} must be mandatory in the mandatory group`);
  }

  if (entry.group === "optional-agent-cli" && entry.requirement !== "optional") {
    errors.push(`${entry.id} must be optional in the optional agent CLI group`);
  }
}

function normalizeSelectedIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort();
}

function normalizeCustomAgentCliTools(
  inputs: readonly CustomAgentCliToolInput[],
  errors: string[]
): ToolSyncCatalogEntry[] {
  return inputs.map((input, index) => {
    const packageName = input.packageName?.trim() ?? "";
    const id = input.id?.trim() || `custom:${packageNameToToolId(packageName)}`;
    const version = input.version?.trim() || "latest";
    const displayName = input.displayName?.trim() || packageName;
    const target = input.target?.trim() || version;

    const entry: ToolSyncCatalogEntry = {
      id,
      displayName,
      packageName,
      version,
      target,
      group: "optional-agent-cli",
      requirement: "optional"
    };

    if (!packageName) {
      errors.push(`customAgentClis[${index}].packageName must be non-empty`);
    }

    validateCatalogEntry(entry, errors);
    return entry;
  });
}

function normalizeVersionSelector(selector: string): string {
  const trimmed = selector.trim();
  return trimmed === "latest" ? "*" : trimmed;
}

function isValidVersionSelector(selector: string): boolean {
  const normalized = normalizeVersionSelector(selector);
  return normalized.length > 0 && semver.validRange(normalized) !== null;
}

function isValidToolId(id: string): boolean {
  return /^[a-z0-9][a-z0-9:-]*$/u.test(id);
}

function packageNameToToolId(packageName: string): string {
  return packageName
    .replace(/^@/u, "")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
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
