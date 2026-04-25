import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  assertTargetIsEmptyOrMissing,
  extractNodeArchive,
  moveExtractedRootToTarget
} from "./node-extract.js";
import { downloadNodeArchive, type DownloadProgress } from "./node-download.js";
import { fetchNodeReleaseMetadata, selectNodeArchive } from "./node-release.js";
import { mapNodePlatform } from "./node-platform.js";
import {
  getRuntimeExecutablePaths,
  verifyNodeRuntime,
  type NodeRuntimeVerificationResult
} from "./node-verify.js";

export interface InstallNodeRuntimeOptions {
  targetDirectory: string;
  versionSelector?: string;
  fetchImpl?: typeof fetch;
  downloadTimeoutMs?: number;
  verifyTimeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface ResolveManagedNodeRuntimeOptions {
  targetDirectory?: string;
  versionSelector?: string;
  fetchImpl?: typeof fetch;
  downloadTimeoutMs?: number;
  verifyTimeoutMs?: number;
  verifyRuntime?: typeof verifyNodeRuntime;
  installRuntime?: typeof installNodeRuntime;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface InstallNodeRuntimeResult {
  version: string;
  npmVersion: string;
  targetDirectory: string;
  nodePath: string;
  npmPath: string;
  archiveUrl: string;
}

export interface ResolveManagedNodeRuntimeResult {
  targetDirectory: string;
  nodePath: string;
  npmPath: string;
  nodeVersion: string;
  npmVersion: string;
  installed: boolean;
}

export function getDefaultManagedNodeRuntimeDirectory(): string {
  return join(homedir(), ".hagiscript", "node-runtime");
}

export async function resolveManagedNodeRuntime(
  options: ResolveManagedNodeRuntimeOptions = {}
): Promise<ResolveManagedNodeRuntimeResult> {
  const targetDirectory = resolve(
    options.targetDirectory ?? getDefaultManagedNodeRuntimeDirectory()
  );
  const verifyRuntime = options.verifyRuntime ?? verifyNodeRuntime;
  const initialVerification = await verifyRuntime(targetDirectory, {
    timeoutMs: options.verifyTimeoutMs
  });

  if (initialVerification.valid) {
    return toResolvedRuntime(initialVerification, false);
  }

  const installRuntime = options.installRuntime ?? installNodeRuntime;
  await installRuntime({
    targetDirectory,
    versionSelector: options.versionSelector,
    fetchImpl: options.fetchImpl,
    downloadTimeoutMs: options.downloadTimeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    onProgress: options.onProgress
  });

  const finalVerification = await verifyRuntime(targetDirectory, {
    timeoutMs: options.verifyTimeoutMs
  });
  assertValidVerification(finalVerification);

  return toResolvedRuntime(finalVerification, true);
}

export async function installNodeRuntime(
  options: InstallNodeRuntimeOptions
): Promise<InstallNodeRuntimeResult> {
  const targetDirectory = resolve(options.targetDirectory);
  await assertTargetIsEmptyOrMissing(targetDirectory);

  const releases = await fetchNodeReleaseMetadata(options.fetchImpl);
  const archive = selectNodeArchive(
    releases,
    options.versionSelector,
    mapNodePlatform()
  );
  const stagingRoot = await mkdtemp(
    join(dirname(targetDirectory), ".hagiscript-node-")
  );
  const archivePath = join(stagingRoot, archive.fileName);

  try {
    await downloadNodeArchive(archive.url, archivePath, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.downloadTimeoutMs,
      onProgress: options.onProgress
    });

    const extractedRoot = await extractNodeArchive(
      archivePath,
      join(stagingRoot, "extract"),
      archive.platform.archiveExtension
    );
    const verification = await verifyNodeRuntime(extractedRoot, {
      timeoutMs: options.verifyTimeoutMs
    });
    assertValidVerification(verification);

    await moveExtractedRootToTarget(extractedRoot, targetDirectory);
    const finalPaths = getRuntimeExecutablePaths(targetDirectory);
    return {
      version: verification.nodeVersion ?? archive.version,
      npmVersion: verification.npmVersion ?? "unknown",
      targetDirectory,
      nodePath: finalPaths.nodePath,
      npmPath: finalPaths.npmPath,
      archiveUrl: archive.url
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

function assertValidVerification(
  verification: NodeRuntimeVerificationResult
): asserts verification is NodeRuntimeVerificationResult & {
  nodeVersion: string;
  npmVersion: string;
  nodePath: string;
  npmPath: string;
} {
  if (!verification.valid) {
    throw new Error(
      `Installed Node.js runtime failed verification: ${verification.failureReason ?? "unknown failure"}`
    );
  }
}

function toResolvedRuntime(
  verification: NodeRuntimeVerificationResult,
  installed: boolean
): ResolveManagedNodeRuntimeResult {
  assertValidVerification(verification);

  return {
    targetDirectory: verification.targetDirectory,
    nodePath: verification.nodePath,
    npmPath: verification.npmPath,
    nodeVersion: verification.nodeVersion,
    npmVersion: verification.npmVersion,
    installed
  };
}
