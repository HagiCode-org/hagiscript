import extractZip from "extract-zip";
import { resolve } from "node:path";
import {
  CommandExecutionError,
  runCommand,
  type CommandRunner
} from "./command-launch.js";

const windowsTarCommands = ["tar.exe", "tar"] as const;
const windowsPowerShellCommands = ["pwsh", "powershell.exe", "powershell"] as const;

export interface ZipExtractionOptions {
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
}

export async function extractZipArchive(
  archivePath: string,
  destination: string,
  options: ZipExtractionOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const runner = options.runCommand ?? runCommand;
  const resolvedDestination = resolve(destination);
  const nativeFailures: string[] = [];

  if (platform === "win32") {
    const nativeResult = await tryExtractZipArchiveWithNativeTools(
      archivePath,
      resolvedDestination,
      runner
    );
    if (nativeResult.success) {
      return;
    }

    nativeFailures.push(...nativeResult.failures);
  }

  try {
    await extractZip(archivePath, {
      dir: resolvedDestination
    });
  } catch (error) {
    const archiveError = error instanceof Error ? error : new Error(String(error));
    const nativeSummary =
      nativeFailures.length > 0
        ? ` Native attempts: ${nativeFailures.join(" | ")}.`
        : "";
    throw new Error(
      `Failed to extract zip archive ${archivePath}: ${archiveError.message}.${nativeSummary}`
    );
  }
}

async function tryExtractZipArchiveWithNativeTools(
  archivePath: string,
  destination: string,
  runner: CommandRunner
): Promise<{ success: boolean; failures: string[] }> {
  const failures: string[] = [];

  for (const command of windowsTarCommands) {
    const result = await tryRunZipExtractionCommand(runner, command, [
      "-xf",
      archivePath,
      "-C",
      destination
    ]);
    if (result.success) {
      return { success: true, failures };
    }
    failures.push(result.failure);
  }

  for (const command of windowsPowerShellCommands) {
    const result = await tryRunZipExtractionCommand(runner, command, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildExpandArchiveCommand(archivePath, destination)
    ]);
    if (result.success) {
      return { success: true, failures };
    }
    failures.push(result.failure);
  }

  return { success: false, failures };
}

async function tryRunZipExtractionCommand(
  runner: CommandRunner,
  command: string,
  args: string[]
): Promise<{ success: true } | { success: false; failure: string }> {
  try {
    await runner(command, args);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      failure: formatCommandFailure(command, error)
    };
  }
}

function buildExpandArchiveCommand(archivePath: string, destination: string): string {
  const escapedArchivePath = escapePowerShellSingleQuotedString(archivePath);
  const escapedDestination = escapePowerShellSingleQuotedString(destination);
  return `Expand-Archive -LiteralPath '${escapedArchivePath}' -DestinationPath '${escapedDestination}' -Force`;
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replaceAll("'", "''");
}

function formatCommandFailure(command: string, error: unknown): string {
  if (error instanceof CommandExecutionError) {
    const details = error.context.stderr.trim() || error.context.stdout.trim() || error.message;
    return `${command}: ${details}`;
  }

  if (error instanceof Error) {
    return `${command}: ${error.message}`;
  }

  return `${command}: ${String(error)}`;
}
