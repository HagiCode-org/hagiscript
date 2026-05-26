import { chmod, mkdir, stat } from "node:fs/promises";
import { path7za } from "7zip-bin";
import {
  CommandExecutionError,
  runCommand,
  type CommandRunner
} from "./command-launch.js";

export interface SevenZipExtractor {
  readonly binaryPath: string;
  extract(archivePath: string, destination: string): Promise<void>;
}

export interface SevenZipExtractorOptions {
  binaryPath?: string;
  runner?: CommandRunner;
}

export class SevenZipExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SevenZipExtractionError";
  }
}

export function getBundledSevenZipBinaryPath(): string {
  const normalized = path7za?.trim();
  if (!normalized) {
    throw new SevenZipExtractionError(
      "Bundled 7z extraction provider is unavailable. Reinstall hagiscript so the packaged 7zip-bin dependency is present."
    );
  }

  return normalized;
}

export function createBundledSevenZipExtractor(
  options: SevenZipExtractorOptions = {}
): SevenZipExtractor {
  const binaryPath =
    options.binaryPath?.trim() || getBundledSevenZipBinaryPath();
  const runner = options.runner ?? runCommand;

  return {
    binaryPath,
    async extract(archivePath: string, destination: string): Promise<void> {
      await mkdir(destination, { recursive: true });

      try {
        await ensureBundledSevenZipBinaryExecutable(binaryPath);
        await runner(
          binaryPath,
          ["x", "-bd", "-y", `-o${destination}`, archivePath],
          {
            maxBuffer: 10 * 1024 * 1024
          }
        );
      } catch (error) {
        const details =
          error instanceof CommandExecutionError
            ? error.context.stderr.trim() ||
              error.context.stdout.trim() ||
              error.message
            : error instanceof Error
              ? error.message
              : String(error);

        throw new SevenZipExtractionError(
          `Failed to extract 7z archive ${archivePath} with bundled provider ${binaryPath}: ${details}`,
          error instanceof Error ? { cause: error } : undefined
        );
      }
    }
  };
}

async function ensureBundledSevenZipBinaryExecutable(
  binaryPath: string
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  let metadata;
  try {
    metadata = await stat(binaryPath);
  } catch {
    return;
  }

  if ((metadata.mode & 0o111) === 0o111) {
    return;
  }

  await chmod(binaryPath, metadata.mode | 0o111);
}
