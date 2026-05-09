import { copyFile, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export function isDownloadCacheEnabled(enabled: boolean | undefined): boolean {
  return enabled ?? true;
}

export function getDefaultDownloadCacheDirectory(): string {
  return join(homedir(), ".hagiscript", "download-cache");
}

export function resolveDownloadCacheDirectory(directory?: string): string {
  const normalized = directory?.trim();
  return resolve(
    normalized && normalized.length > 0
      ? normalized
      : getDefaultDownloadCacheDirectory()
  );
}

export async function copyFileFromCache(
  cachePath: string,
  destinationPath: string
): Promise<number | undefined> {
  try {
    const cachedFile = await stat(cachePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(cachePath, destinationPath);
    return cachedFile.size;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function copyDirectoryFromCache(
  cachePath: string,
  destinationPath: string
): Promise<boolean> {
  try {
    await stat(cachePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(cachePath, destinationPath, {
      recursive: true,
      force: false,
      errorOnExist: true
    });
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

export async function storeFileInCache(
  sourcePath: string,
  cachePath: string
): Promise<void> {
  try {
    await stat(cachePath);
    return;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  const temporaryPath = getTemporaryCachePath(cachePath);
  await mkdir(dirname(cachePath), { recursive: true });
  await copyFile(sourcePath, temporaryPath);
  await moveIntoCache(temporaryPath, cachePath);
}

export async function storeDirectoryInCache(
  sourcePath: string,
  cachePath: string
): Promise<void> {
  try {
    await stat(cachePath);
    return;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  const temporaryPath = getTemporaryCachePath(cachePath);
  await mkdir(dirname(cachePath), { recursive: true });
  await cp(sourcePath, temporaryPath, {
    recursive: true,
    force: false,
    errorOnExist: true
  });
  await moveIntoCache(temporaryPath, cachePath);
}

function getTemporaryCachePath(cachePath: string): string {
  return `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

async function moveIntoCache(
  temporaryPath: string,
  cachePath: string
): Promise<void> {
  try {
    await rename(temporaryPath, cachePath);
  } catch (error) {
    if (!isAlreadyCachedError(error)) {
      throw error;
    }
  } finally {
    await rm(temporaryPath, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isAlreadyCachedError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}
