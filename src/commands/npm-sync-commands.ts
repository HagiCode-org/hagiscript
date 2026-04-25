import { Command, InvalidArgumentError } from "commander";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDefaultManagedNodeRuntimeDirectory,
  resolveManagedNodeRuntime
} from "../runtime/node-installer.js";
import {
  NpmManifestValidationError,
  NpmSyncCommandError,
  syncNpmGlobals,
  validateRegistryMirror,
  type NpmSyncLogEvent,
  type NpmSyncSummary
} from "../runtime/npm-sync.js";

interface NpmSyncCommandOptions {
  runtime?: string;
  manifest?: string;
  managedRuntime?: string;
  registryMirror?: string;
  selectedAgentCli?: string[];
  customAgentCli?: string[];
}

export function registerNpmSyncCommand(program: Command): void {
  program
    .command("npm-sync")
    .description(
      "sync managed npm tools using HagiScript's Node.js runtime, or an explicit runtime for compatibility"
    )
    .option("--runtime <path>", "explicit Node.js runtime directory")
    .option(
      "--managed-runtime <path>",
      "HagiScript-managed runtime directory to verify or install before sync"
    )
    .option("--manifest <path>", "npm-sync manifest JSON file")
    .option(
      "--registry-mirror <url>",
      "npm registry mirror URL to use for this sync run"
    )
    .option(
      "--selected-agent-cli <id>",
      "selected optional agent CLI ID for product-managed tool sync",
      collectValues,
      []
    )
    .option(
      "--custom-agent-cli <package[@version]>",
      "custom npm-installable agent CLI for product-managed tool sync",
      collectValues,
      []
    )
    .action(async (options: NpmSyncCommandOptions, command: Command) => {
      const explicitRuntime = options.runtime
        ? validatePathOption(options.runtime, "--runtime")
        : undefined;
      const registryMirror = validateRegistryMirror(
        options.registryMirror,
        "--registry-mirror"
      );
      const selectedAgentCliIds = options.selectedAgentCli ?? [];
      const customAgentCliSelectors = options.customAgentCli ?? [];
      const hasInlineToolSelection =
        selectedAgentCliIds.length > 0 || customAgentCliSelectors.length > 0;
      const manifestPath = options.manifest
        ? validatePathOption(options.manifest, "--manifest")
        : hasInlineToolSelection
          ? await writeInlineToolManifest(
              selectedAgentCliIds,
              customAgentCliSelectors
            )
          : undefined;

      if (!manifestPath) {
        throw new InvalidArgumentError(
          "--manifest is required unless --selected-agent-cli or --custom-agent-cli is provided."
        );
      }

      const managedRuntimePath = options.managedRuntime
        ? validatePathOption(options.managedRuntime, "--managed-runtime")
        : getDefaultManagedNodeRuntimeDirectory();

      try {
        const runtimePath = explicitRuntime ?? (await resolveManagedNodeRuntime({
          targetDirectory: managedRuntimePath
        })).targetDirectory;

        await syncNpmGlobals({
          runtimePath,
          manifestPath,
          registryMirror,
          onLog: printNpmSyncLog
        });
      } catch (error) {
        command.error(formatNpmSyncError(error), { exitCode: 1 });
      }
    });
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function writeInlineToolManifest(
  selectedAgentCliIds: readonly string[],
  customAgentCliSelectors: readonly string[]
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hagiscript-tool-sync-"));
  const manifestPath = join(directory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        tools: {
          optionalAgentCliSyncEnabled: true,
          selectedOptionalAgentCliIds: selectedAgentCliIds,
          customAgentClis: customAgentCliSelectors.map(parseCustomAgentCli)
        }
      },
      null,
      2
    )
  );
  return manifestPath;
}

function parseCustomAgentCli(selector: string): {
  packageName: string;
  version?: string;
  target?: string;
} {
  const trimmed = selector.trim();
  const versionSeparator = trimmed.startsWith("@")
    ? trimmed.indexOf("@", 1)
    : trimmed.indexOf("@");

  if (versionSeparator <= 0) {
    return { packageName: trimmed };
  }

  const packageName = trimmed.slice(0, versionSeparator);
  const version = trimmed.slice(versionSeparator + 1);
  return {
    packageName,
    version,
    target: version
  };
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
        `Manifest validated: ${event.manifestPath} (${event.packageCount} packages, mode=${event.syncMode})\n`
      );
      if (event.registryMirror) {
        process.stdout.write(`Registry mirror: ${event.registryMirror}\n`);
      }
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
        `Plan: ${event.action.packageName} ${event.action.action} installed=${event.action.installedVersion ?? "missing"} required=${event.action.requiredRange} selector=${event.action.selectedInstallSelector}${formatToolMetadata(event.action)}\n`
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
  process.stdout.write(`Mode: ${summary.syncMode}\n`);
  if (summary.registryMirror) {
    process.stdout.write(`Registry mirror: ${summary.registryMirror}\n`);
  }
  process.stdout.write(`Packages: ${summary.packageCount}\n`);
  process.stdout.write(`No-op: ${summary.noopCount}\n`);
  process.stdout.write(`Changed: ${summary.changedCount}\n`);
}

function formatToolMetadata(action: {
  toolId?: string;
  toolGroup?: string;
}): string {
  if (!action.toolId) {
    return "";
  }

  return ` tool=${action.toolId} group=${action.toolGroup ?? "unknown"}`;
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
