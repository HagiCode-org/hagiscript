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
  type NpmSyncFallbackEvent,
  type NpmSyncLogEvent,
  type NpmSyncSummary
} from "../runtime/npm-sync.js";

interface NpmSyncCommandOptions {
  runtime?: string;
  manifest?: string;
  managedRuntime?: string;
  registryMirror?: string;
  prefix?: string;
  mirrorOnly?: boolean;
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
      "--prefix <path>",
      "npm global prefix directory for inventory and package installation"
    )
    .option(
      "--mirror-only",
      "disable automatic retry against https://registry.npmjs.org/ when a registry mirror is configured"
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
      const prefix = options.prefix
        ? validatePathOption(options.prefix, "--prefix")
        : undefined;
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
        const fallbackPolicy = options.mirrorOnly ? "mirror-only" : "auto";

        await syncNpmGlobals({
          runtimePath,
          manifestPath,
          registryMirror,
          fallbackPolicy,
          npmOptions: prefix ? { prefix } : undefined,
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
    case "fallback-policy":
      process.stdout.write(`Fallback policy: ${event.fallbackPolicy}\n`);
      break;
    case "fallback-used":
      process.stdout.write(
        `Fallback used: ${formatFallbackEvent(event.fallback)}\n`
      );
      break;
    case "mirror-only":
      process.stdout.write(
        `Mirror-only: official registry fallback disabled for ${event.registryMirror}\n`
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
    process.stdout.write(`Fallback policy: ${summary.fallbackPolicy}\n`);
    process.stdout.write(`Fallback used: ${summary.fallbackUsed ? "yes" : "no"}\n`);
    for (const fallback of summary.fallbackEvents) {
      process.stdout.write(`Fallback detail: ${formatFallbackEvent(fallback)}\n`);
    }
  }
  process.stdout.write(`Packages: ${summary.packageCount}\n`);
  process.stdout.write(`No-op: ${summary.noopCount}\n`);
  process.stdout.write(`Changed: ${summary.changedCount}\n`);
}

function formatFallbackEvent(fallback: NpmSyncFallbackEvent): string {
  const packageSegment = fallback.packageName
    ? ` package=${fallback.packageName}`
    : "";
  return `${fallback.commandKind}${packageSegment} mirror=${fallback.mirrorRegistry} fallback=${fallback.fallbackRegistry} success=${fallback.retrySucceeded}`;
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
    if (error.registryMirror) {
      lines.push(`Registry mirror: ${error.registryMirror}`);
      lines.push(`Fallback policy: ${error.fallbackPolicy}`);
      if (error.fallbackPolicy === "mirror-only") {
        lines.push("Mirror-only: official registry fallback disabled.");
      }
    }
    if (error.fallbackAttempted && error.fallbackRegistry) {
      lines.push(`Fallback registry: ${error.fallbackRegistry}`);
    }

    if (error.mirrorContext) {
      lines.push(
        `Mirror command: ${error.mirrorContext.command} ${error.mirrorContext.args.join(" ")}`
      );
      if (error.mirrorContext.stderr.trim().length > 0) {
        lines.push(`mirror stderr: ${error.mirrorContext.stderr.trim()}`);
      }
      if (error.mirrorContext.stdout.trim().length > 0) {
        lines.push(`mirror stdout: ${error.mirrorContext.stdout.trim()}`);
      }
    }

    if (error.officialContext) {
      lines.push(
        `Official retry command: ${error.officialContext.command} ${error.officialContext.args.join(" ")}`
      );
      if (error.officialContext.stderr.trim().length > 0) {
        lines.push(`official stderr: ${error.officialContext.stderr.trim()}`);
      }
      if (error.officialContext.stdout.trim().length > 0) {
        lines.push(`official stdout: ${error.officialContext.stdout.trim()}`);
      }
    }

    if (!error.mirrorContext && !error.officialContext) {
      lines.push(`Command: ${error.command} ${error.args.join(" ")}`);
      if (error.stderr.trim().length > 0) {
        lines.push(`stderr: ${error.stderr.trim()}`);
      }
      if (error.stdout.trim().length > 0) {
        lines.push(`stdout: ${error.stdout.trim()}`);
      }
    }
    return lines.join("\n");
  }

  return error instanceof Error ? error.message : String(error);
}
