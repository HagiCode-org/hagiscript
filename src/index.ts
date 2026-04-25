import { packageName, packageVersion } from "./version.js";

export {
  getPackageMetadata,
  packageName,
  packageVersion,
  type PackageMetadata
} from "./version.js";

export interface HagiscriptRuntimeInfo {
  packageName: string;
  version: string;
  status: "foundation";
}

export function createRuntimeInfo(): HagiscriptRuntimeInfo {
  return {
    packageName,
    version: packageVersion,
    status: "foundation"
  };
}

export {
  getDefaultManagedNodeRuntimeDirectory,
  installNodeRuntime,
  resolveManagedNodeRuntime,
  type InstallNodeRuntimeResult,
  type ResolveManagedNodeRuntimeResult
} from "./runtime/node-installer.js";
export {
  verifyNodeRuntime,
  type NodeRuntimeVerificationResult
} from "./runtime/node-verify.js";
export {
  createNpmSyncPlan,
  loadNpmSyncManifest,
  normalizeGlobalInventory,
  syncNpmGlobals,
  validateNpmSyncManifest,
  type InstalledGlobalPackages,
  type NpmSyncActionKind,
  type NpmSyncActionResult,
  type NpmSyncCommandKind,
  type NpmSyncFallbackEvent,
  type NpmSyncFallbackPolicy,
  type NpmSyncManifest,
  type NpmSyncManifestEntry,
  type NpmSyncPlannedAction,
  type NpmSyncRuntimeMetadata,
  type NpmSyncSummary
} from "./runtime/npm-sync.js";
export {
  buildToolSyncPackageSet,
  builtInToolSyncCatalog,
  normalizeToolSyncEntry,
  validateToolSyncCatalog,
  type CustomAgentCliToolInput,
  type ToolSyncCatalogEntry,
  type ToolSyncGroupId,
  type ToolSyncPackageConstraint,
  type ToolSyncRequirement,
  type ToolSyncSelection
} from "./runtime/tool-sync-catalog.js";
