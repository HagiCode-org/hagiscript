import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertTargetIsEmptyOrMissing,
  moveExtractedRootToTarget
} from "./node-extract.js";
import {
  CommandExecutionError,
  runCommand,
  type CommandRunner,
  type CommandRunnerOptions
} from "./command-launch.js";

export interface InstallManagedDotnetRuntimeOptions {
  targetDirectory: string;
  version: string;
  runner?: CommandRunner;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  architecture?: string;
  timeoutMs?: number;
  scriptBaseUrl?: string;
  verbose?: boolean;
}

export interface ManagedDotnetVerificationResult {
  valid: boolean;
  targetDirectory: string;
  dotnetPath: string;
  installedRuntimes: Record<string, string[]>;
  requiredVersion: string;
  failureReason?: string;
  infoOutput?: string;
  listRuntimesOutput?: string;
}

export interface InstallManagedDotnetRuntimeResult extends ManagedDotnetVerificationResult {
  valid: true;
}

const managedDotnetRuntimeNames = [
  "Microsoft.NETCore.App",
  "Microsoft.AspNetCore.App"
] as const;
const windowsPowerShellCommands = ["pwsh", "powershell.exe", "powershell"] as const;

export async function installManagedDotnetRuntime(
  options: InstallManagedDotnetRuntimeOptions
): Promise<InstallManagedDotnetRuntimeResult> {
  const targetDirectory = resolve(options.targetDirectory);
  const version = normalizeRequiredVersion(options.version);
  const runner = options.runner ?? runCommand;
  const platform = options.platform ?? process.platform;
  const architecture = mapDotnetArchitecture(options.architecture ?? process.arch);
  const stagingRoot = await mkdtemp(join(dirname(targetDirectory), ".hagiscript-dotnet-"));
  const stagedRuntimeDirectory = join(stagingRoot, "runtime");
  const installerScriptPath = join(
    stagingRoot,
    platform === "win32" ? "dotnet-install.ps1" : "dotnet-install.sh"
  );

  await assertTargetIsEmptyOrMissing(targetDirectory);

  try {
    await downloadDotnetInstallScript(installerScriptPath, {
      platform,
      scriptBaseUrl: options.scriptBaseUrl,
      fetchImpl: options.fetchImpl
    });

    for (const runtimeKind of ["dotnet", "aspnetcore"] as const) {
      const invocation = buildDotnetInstallInvocation({
        installerScriptPath,
        installDirectory: stagedRuntimeDirectory,
        version,
        runtime: runtimeKind,
        platform,
        architecture,
        verbose: options.verbose
      });
      await runDotnetInstallInvocation(runner, invocation, {
        timeoutMs: options.timeoutMs,
        env: {
          ...process.env,
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          DOTNET_NOLOGO: "1",
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1"
        }
      });
    }

    const verification = await verifyManagedDotnetRuntime({
      targetDirectory: stagedRuntimeDirectory,
      version,
      runner,
      platform,
      timeoutMs: options.timeoutMs
    });

    if (!verification.valid) {
      throw new Error(
        `Installed .NET runtime failed verification: ${verification.failureReason ?? "unknown failure"}`
      );
    }

    await moveExtractedRootToTarget(stagedRuntimeDirectory, targetDirectory);
    return {
      ...verification,
      valid: true,
      targetDirectory
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function verifyManagedDotnetRuntime(options: {
  targetDirectory: string;
  version: string;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}): Promise<ManagedDotnetVerificationResult> {
  const targetDirectory = resolve(options.targetDirectory);
  const version = normalizeRequiredVersion(options.version);
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runCommand;
  const dotnetPath = getManagedDotnetExecutablePath(targetDirectory, platform);

  try {
    await access(dotnetPath);
  } catch (error) {
    return {
      valid: false,
      targetDirectory,
      dotnetPath,
      installedRuntimes: {},
      requiredVersion: version,
      failureReason:
        error instanceof Error
          ? `Managed dotnet executable is missing: ${error.message}`
          : "Managed dotnet executable is missing."
    };
  }

  try {
    const [infoResult, listRuntimesResult] = await Promise.all([
      runner(dotnetPath, ["--info"], {
        timeoutMs: options.timeoutMs
      }),
      runner(dotnetPath, ["--list-runtimes"], {
        timeoutMs: options.timeoutMs
      })
    ]);
    const installedRuntimes = parseInstalledDotnetRuntimes(listRuntimesResult.stdout);

    for (const runtimeName of managedDotnetRuntimeNames) {
      if (!installedRuntimes[runtimeName]?.includes(version)) {
        return {
          valid: false,
          targetDirectory,
          dotnetPath,
          installedRuntimes,
          requiredVersion: version,
          infoOutput: infoResult.stdout,
          listRuntimesOutput: listRuntimesResult.stdout,
          failureReason: `Missing required runtime ${runtimeName} ${version}.`
        };
      }
    }

    return {
      valid: true,
      targetDirectory,
      dotnetPath,
      installedRuntimes,
      requiredVersion: version,
      infoOutput: infoResult.stdout,
      listRuntimesOutput: listRuntimesResult.stdout
    };
  } catch (error) {
    return {
      valid: false,
      targetDirectory,
      dotnetPath,
      installedRuntimes: {},
      requiredVersion: version,
      failureReason:
        error instanceof Error ? error.message : "Failed to execute managed dotnet verification."
    };
  }
}

export function getManagedDotnetExecutablePath(
  targetDirectory: string,
  platform: NodeJS.Platform = process.platform
): string {
  return join(resolve(targetDirectory), platform === "win32" ? "dotnet.exe" : "dotnet");
}

export function parseInstalledDotnetRuntimes(
  output: string
): Record<string, string[]> {
  const runtimes: Record<string, string[]> = {};

  for (const line of output.split(/\r?\n/u)) {
    const match = /^(?<name>\S+)\s+(?<version>\S+)\s+\[[^\]]+\]$/u.exec(line.trim());
    if (!match?.groups?.name || !match.groups.version) {
      continue;
    }

    const versions = (runtimes[match.groups.name] ??= []);
    versions.push(match.groups.version);
  }

  return runtimes;
}

export function mapDotnetArchitecture(architecture: string): "x64" | "arm64" {
  switch (architecture) {
    case "x64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported .NET runtime architecture: ${architecture}`);
  }
}

function normalizeRequiredVersion(version: string): string {
  const normalized = version.trim();
  if (!normalized) {
    throw new Error("Managed .NET runtime version must be a non-empty string.");
  }

  return normalized;
}

async function downloadDotnetInstallScript(
  destinationPath: string,
  options: {
    platform: NodeJS.Platform;
    scriptBaseUrl?: string;
    fetchImpl?: typeof fetch;
  }
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is unavailable for downloading the .NET installer.");
  }

  const url = buildDotnetInstallScriptUrl(options.platform, options.scriptBaseUrl);
  const response = await fetchImpl(url);

  if (!response.ok) {
    throw new Error(`Failed to download .NET installer ${url}: HTTP ${response.status}`);
  }

  const scriptContents = await response.text();
  await writeFile(destinationPath, scriptContents, "utf8");
  if (options.platform !== "win32") {
    await chmod(destinationPath, 0o755);
  }
}

export function buildDotnetInstallScriptUrl(
  platform: NodeJS.Platform,
  scriptBaseUrl = "https://dot.net/v1"
): string {
  const normalizedBaseUrl = scriptBaseUrl.replace(/\/+$/u, "");
  return `${normalizedBaseUrl}/${platform === "win32" ? "dotnet-install.ps1" : "dotnet-install.sh"}`;
}

function buildDotnetInstallInvocation(options: {
  installerScriptPath: string;
  installDirectory: string;
  version: string;
  runtime: "dotnet" | "aspnetcore";
  platform: NodeJS.Platform;
  architecture: "x64" | "arm64";
  verbose?: boolean;
}): {
  commands: readonly string[];
  args: string[];
} {
  if (options.platform === "win32") {
    return {
      commands: windowsPowerShellCommands,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        options.installerScriptPath,
        "-InstallDir",
        options.installDirectory,
        "-Version",
        options.version,
        "-Runtime",
        options.runtime,
        "-Architecture",
        options.architecture,
        "-NoPath",
        ...(options.verbose ? ["-Verbose"] : [])
      ]
    };
  }

  return {
    commands: ["bash"],
    args: [
      options.installerScriptPath,
      "--install-dir",
      options.installDirectory,
      "--version",
      options.version,
      "--runtime",
      options.runtime,
      "--architecture",
      options.architecture,
      "--no-path",
      ...(options.verbose ? ["--verbose"] : [])
    ]
  };
}

async function runDotnetInstallInvocation(
  runner: CommandRunner,
  invocation: {
    commands: readonly string[];
    args: string[];
  },
  options: CommandRunnerOptions
): Promise<void> {
  const failures: string[] = [];

  for (const command of invocation.commands) {
    try {
      await runner(command, invocation.args, options);
      return;
    } catch (error) {
      failures.push(formatDotnetInstallFailure(command, invocation.args, error));
    }
  }

  throw new Error(
    `Failed to execute .NET installer. Attempts:\n${failures.map((failure) => `- ${failure}`).join("\n")}`
  );
}

function formatDotnetInstallFailure(
  command: string,
  args: string[],
  error: unknown
): string {
  const commandLine = `${command} ${args.join(" ")}`;

  if (error instanceof CommandExecutionError) {
    const details = [
      error.context.shortMessage || error.message,
      error.context.stderr.trim() ? `stderr: ${error.context.stderr.trim()}` : "",
      error.context.stdout.trim() ? `stdout: ${error.context.stdout.trim()}` : ""
    ].filter(Boolean);
    return `${commandLine} => ${details.join(" | ")}`;
  }

  return `${commandLine} => ${error instanceof Error ? error.message : String(error)}`;
}
