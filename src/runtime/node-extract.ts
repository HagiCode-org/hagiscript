import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { createGunzip, gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";

export class NodeRuntimeExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeRuntimeExtractionError";
  }
}

export async function extractNodeArchive(
  archivePath: string,
  stagingDirectory: string,
  archiveExtension: "zip" | "tar.xz"
): Promise<string> {
  await mkdir(stagingDirectory, { recursive: true });

  if (archiveExtension === "zip") {
    await extractZip(archivePath, stagingDirectory);
  } else {
    await extractTar(archivePath, stagingDirectory);
  }

  return findExtractedRoot(stagingDirectory);
}

export async function moveExtractedRootToTarget(
  extractedRoot: string,
  targetDirectory: string
): Promise<void> {
  await assertTargetIsEmptyOrMissing(targetDirectory);
  await mkdir(dirname(targetDirectory), { recursive: true });
  await rm(targetDirectory, { recursive: true, force: true });
  await rename(extractedRoot, targetDirectory);
}

export async function assertTargetIsEmptyOrMissing(
  targetDirectory: string
): Promise<void> {
  try {
    const entries = await readdir(targetDirectory);
    if (entries.length > 0) {
      throw new NodeRuntimeExtractionError(
        `Target directory is not empty: ${targetDirectory}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    if (error instanceof NodeRuntimeExtractionError) {
      throw error;
    }

    const stats = await stat(targetDirectory).catch(() => undefined);
    if (stats && !stats.isDirectory()) {
      throw new NodeRuntimeExtractionError(
        `Target path exists but is not a directory: ${targetDirectory}`
      );
    }

    throw error;
  }
}

async function extractZip(
  archivePath: string,
  destination: string
): Promise<void> {
  const extractors = ["unzip", "bsdtar"];
  let lastError: Error | undefined;

  for (const extractor of extractors) {
    try {
      const args =
        extractor === "unzip"
          ? ["-q", archivePath, "-d", destination]
          : ["-xf", archivePath, "-C", destination];
      await runExtractor(extractor, args);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new NodeRuntimeExtractionError(
    "Failed to extract zip archive. Install unzip or bsdtar, or provide a valid Node.js archive.",
    lastError ? { cause: lastError } : undefined
  );
}

async function extractTar(
  archivePath: string,
  destination: string
): Promise<void> {
  try {
    await runExtractor("tar", ["-xJf", archivePath, "-C", destination]);
  } catch (error) {
    const directError =
      error instanceof Error ? error : new Error(String(error));
    try {
      await extractTarWithNode(archivePath, destination);
    } catch (fallbackError) {
      throw new NodeRuntimeExtractionError(
        `Failed to extract tar archive: ${directError.message}`,
        fallbackError instanceof Error ? { cause: fallbackError } : undefined
      );
    }
  }
}

async function runExtractor(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8").trim()}`
        )
      );
    });
  });
}

async function findExtractedRoot(stagingDirectory: string): Promise<string> {
  const entries = await readdir(stagingDirectory, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  if (directories.length !== 1) {
    throw new NodeRuntimeExtractionError(
      `Expected exactly one extracted Node.js root in staging directory, found ${directories.length}.`
    );
  }

  return join(stagingDirectory, directories[0].name);
}

async function extractTarWithNode(
  archivePath: string,
  destination: string
): Promise<void> {
  const tarPath = archivePath.endsWith(".gz")
    ? `${archivePath}.tar`
    : `${archivePath}.decompressed.tar`;

  try {
    if (archivePath.endsWith(".gz")) {
      await pipeline(
        createReadStream(archivePath),
        createGunzip(),
        createWriteStream(tarPath)
      );
    } else {
      await writeFile(tarPath, gunzipSync(await readFile(archivePath)));
    }
    await extractTarBuffer(await readFile(tarPath), destination);
  } finally {
    await rm(tarPath, { force: true }).catch(() => undefined);
  }
}

async function extractTarBuffer(
  buffer: Buffer,
  destination: string
): Promise<void> {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const sizeText = header
      .toString("utf8", 124, 136)
      .replace(/\0.*$/, "")
      .trim();
    const typeFlag = header.toString("utf8", 156, 157);
    const size = parseInt(sizeText || "0", 8);
    const outputPath = safeJoin(destination, name);

    if (typeFlag === "5") {
      await mkdir(outputPath, { recursive: true });
    } else if (typeFlag === "0" || typeFlag === "") {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        buffer.subarray(offset + 512, offset + 512 + size)
      );
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function safeJoin(root: string, entryName: string): string {
  const normalized = join(root, entryName);
  const rel = relative(root, normalized);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new NodeRuntimeExtractionError(
      `Archive entry escapes extraction directory: ${basename(entryName)}`
    );
  }

  return normalized;
}
