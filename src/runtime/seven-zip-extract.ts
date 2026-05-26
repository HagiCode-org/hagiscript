import { chmod, mkdir, stat } from "node:fs/promises";
import { path7za } from "7zip-bin";
import {
  CommandExecutionError,
  normalizeCommandPath,
  runCommand,
  type CommandRunner
} from "./command-launch.js";

export interface SevenZipExtractor {
  readonly binaryPath: string;
  extract(archivePath: string, destination: string): Promise<void>;
}

export interface SevenZipExtractorOptions {
  binaryPath?: string;
  systemFallbackBinaryPath?: string | null;
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
  const systemFallbackBinaryPath = normalizeSystemFallbackBinaryPath(
    options.systemFallbackBinaryPath,
    binaryPath
  );

  return {
    binaryPath,
    async extract(archivePath: string, destination: string): Promise<void> {
      await mkdir(destination, { recursive: true });

      try {
        await extractWithBinary(runner, binaryPath, archivePath, destination);
      } catch (error) {
        if (
          systemFallbackBinaryPath &&
          shouldRetryWithSystemFallback(binaryPath, error)
        ) {
          try {
            await extractWithBinary(
              runner,
              systemFallbackBinaryPath,
              archivePath,
              destination
            );
            return;
          } catch (fallbackError) {
            throw new SevenZipExtractionError(
              `Failed to extract 7z archive ${archivePath} with bundled provider ${binaryPath}: ${formatExtractionFailureDetails(error)}. Fallback ${systemFallbackBinaryPath} also failed: ${formatExtractionFailureDetails(fallbackError)}`,
              fallbackError instanceof Error
                ? { cause: fallbackError }
                : error instanceof Error
                  ? { cause: error }
                  : undefined
            );
          }
        }

        throw new SevenZipExtractionError(
          `Failed to extract 7z archive ${archivePath} with bundled provider ${binaryPath}: ${formatExtractionFailureDetails(error)}`,
          error instanceof Error ? { cause: error } : undefined
        );
      }
    }
  };
}

async function extractWithBinary(
  runner: CommandRunner,
  binaryPath: string,
  archivePath: string,
  destination: string
): Promise<void> {
  await ensureBundledSevenZipBinaryExecutable(binaryPath);
  await runner(
    binaryPath,
    ["x", "-bd", "-y", `-o${destination}`, archivePath],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );
}

function shouldRetryWithSystemFallback(
  binaryPath: string,
  error: unknown
): boolean {
  const normalizedBinaryPath = normalizeCommandPath(binaryPath).toLowerCase();
  if (
    normalizedBinaryPath === "7z" ||
    normalizedBinaryPath.endsWith("/7z") ||
    normalizedBinaryPath.endsWith("/7z.exe") ||
    normalizedBinaryPath.endsWith("\\7z") ||
    normalizedBinaryPath.endsWith("\\7z.exe")
  ) {
    return false;
  }

  return formatExtractionFailureDetails(error)
    .toLowerCase()
    .includes("unsupported method");
}

function normalizeSystemFallbackBinaryPath(
  value: string | null | undefined,
  primaryBinaryPath: string
): string | null {
  const normalized = value === undefined ? "7z" : value?.trim() || "";
  if (!normalized) {
    return null;
  }

  return normalizeCommandPath(normalized) ===
    normalizeCommandPath(primaryBinaryPath)
    ? null
    : normalized;
}

function formatExtractionFailureDetails(error: unknown): string {
  if (error instanceof CommandExecutionError) {
    return (
      error.context.stderr.trim() ||
      error.context.stdout.trim() ||
      error.message
    );
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
