import { Command, InvalidArgumentError } from "commander";
import {
  NpmManifestValidationError,
  NpmSyncCommandError,
  syncNpmGlobals,
  type NpmSyncLogEvent,
  type NpmSyncSummary
} from "../runtime/npm-sync.js";

interface NpmSyncCommandOptions {
  runtime?: string;
  manifest?: string;
}

export function registerNpmSyncCommand(program: Command): void {
  program
    .command("npm-sync")
    .description("sync npm global packages in an explicit Node.js runtime")
    .requiredOption("--runtime <path>", "target Node.js runtime directory")
    .requiredOption("--manifest <path>", "npm-sync manifest JSON file")
    .action(async (options: NpmSyncCommandOptions, command: Command) => {
      const runtimePath = validatePathOption(options.runtime, "--runtime");
      const manifestPath = validatePathOption(options.manifest, "--manifest");

      try {
        await syncNpmGlobals({
          runtimePath,
          manifestPath,
          onLog: printNpmSyncLog
        });
      } catch (error) {
        command.error(formatNpmSyncError(error), { exitCode: 1 });
      }
    });
}

function validatePathOption(
  value: string | undefined,
  optionName: string
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new InvalidArgumentError(`${optionName} must be a non-empty path.`);
  }

  if (normalized.includes("\0")) {
    throw new InvalidArgumentError(
      `${optionName} contains an invalid null byte.`
    );
  }

  return normalized;
}

function printNpmSyncLog(event: NpmSyncLogEvent): void {
  switch (event.type) {
    case "manifest-loaded":
      process.stdout.write(
        `Manifest validated: ${event.manifestPath} (${event.packageCount} packages)\n`
      );
      break;
    case "runtime-valid":
      process.stdout.write(
        `Runtime validated: ${event.runtime.targetDirectory}\n`
      );
      process.stdout.write(
        `node: ${event.runtime.nodePath} (${event.runtime.nodeVersion})\n`
      );
      process.stdout.write(
        `npm: ${event.runtime.npmPath} (${event.runtime.npmVersion})\n`
      );
      break;
    case "inventory":
      process.stdout.write(
        `Detected global packages: ${Object.keys(event.packages).sort().length}\n`
      );
      break;
    case "planned-action":
      process.stdout.write(
        `Plan: ${event.action.packageName} ${event.action.action} installed=${event.action.installedVersion ?? "missing"} required=${event.action.requiredRange} selector=${event.action.selectedInstallSelector}\n`
      );
      break;
    case "skip":
      process.stdout.write(
        `Skip: ${event.action.packageName} already satisfies range\n`
      );
      break;
    case "install-start":
      process.stdout.write(
        `Install: ${event.action.packageName} using ${event.action.selectedInstallSelector}\n`
      );
      break;
    case "install-complete":
      process.stdout.write(
        `Synced: ${event.action.packageName} (${event.action.action})\n`
      );
      break;
    case "summary":
      printSummary(event.summary);
      break;
  }
}

function printSummary(summary: NpmSyncSummary): void {
  process.stdout.write(`npm-sync complete.\n`);
  process.stdout.write(`Runtime: ${summary.runtime.targetDirectory}\n`);
  process.stdout.write(`Manifest: ${summary.manifestPath}\n`);
  process.stdout.write(`Packages: ${summary.packageCount}\n`);
  process.stdout.write(`No-op: ${summary.noopCount}\n`);
  process.stdout.write(`Changed: ${summary.changedCount}\n`);
}

function formatNpmSyncError(error: unknown): string {
  if (error instanceof NpmManifestValidationError) {
    return error.message;
  }

  if (error instanceof NpmSyncCommandError) {
    const lines = [error.message];
    if (error.packageName) {
      lines.push(`Package: ${error.packageName}`);
    }
    lines.push(`Command: ${error.command} ${error.args.join(" ")}`);
    if (error.stderr.trim().length > 0) {
      lines.push(`stderr: ${error.stderr.trim()}`);
    }
    if (error.stdout.trim().length > 0) {
      lines.push(`stdout: ${error.stdout.trim()}`);
    }
    return lines.join("\n");
  }

  return error instanceof Error ? error.message : String(error);
}
