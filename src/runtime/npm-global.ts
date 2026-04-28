import {
  CommandExecutionError,
  getCommandLaunchOptions,
  runCommand as defaultRunCommand
} from "./command-launch.js";

export interface NpmCommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

export interface NpmCommandFailureContext extends NpmCommandResult {
  exitCode?: string | number | null;
}

export class NpmCommandError extends Error {
  readonly context: NpmCommandFailureContext;

  constructor(message: string, context: NpmCommandFailureContext) {
    super(message);
    this.name = "NpmCommandError";
    this.context = context;
  }
}

export interface NpmGlobalCommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  registryMirror?: string;
  prefix?: string;
  runCommand?: (
    command: string,
    args: string[],
    timeoutMs: number,
    launchOptions?: { shell?: boolean }
  ) => Promise<NpmCommandResult>;
}

export async function listGlobalPackages(
  npmPath: string,
  options: NpmGlobalCommandOptions = {}
): Promise<NpmCommandResult> {
  return runNpmCommand(npmPath, buildListGlobalPackagesArgs(options), options);
}

export async function installGlobalPackage(
  npmPath: string,
  selector: string,
  options: NpmGlobalCommandOptions = {}
): Promise<NpmCommandResult> {
  return runNpmCommand(
    npmPath,
    buildInstallGlobalPackageArgs(selector, options),
    options
  );
}

export function buildListGlobalPackagesArgs(
  options: NpmGlobalCommandOptions = {}
): string[] {
  return appendGlobalNpmOptions(["list", "-g", "--depth=0", "--json"], options);
}

export function buildInstallGlobalPackageArgs(
  selector: string,
  options: NpmGlobalCommandOptions = {}
): string[] {
  return appendGlobalNpmOptions(["install", "-g", selector], options);
}

function appendGlobalNpmOptions(
  args: string[],
  options: NpmGlobalCommandOptions
): string[] {
  const nextArgs = options.registryMirror
    ? [...args, "--registry", options.registryMirror]
    : [...args];

  return options.prefix ? [...nextArgs, "--prefix", options.prefix] : nextArgs;
}

async function runNpmCommand(
  npmPath: string,
  args: string[],
  options: NpmGlobalCommandOptions
): Promise<NpmCommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const runner = options.runCommand
    ? options.runCommand
    : (
        command: string,
        commandArgs: string[],
        commandTimeoutMs: number,
        launchOptions?: { shell?: boolean }
      ) =>
        execNpmCommand(
          command,
          commandArgs,
          commandTimeoutMs,
          options.env,
          launchOptions
        );

  return runner(
    npmPath,
    args,
    timeoutMs,
    getCommandLaunchOptions(npmPath, { platform: options.platform })
  );
}

async function execNpmCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  launchOptions: { shell?: boolean } = {}
): Promise<NpmCommandResult> {
  try {
    const { stdout, stderr } = await defaultRunCommand(command, args, {
      timeoutMs,
      env,
      shell: launchOptions.shell,
      maxBuffer: 10 * 1024 * 1024
    });

    return {
      command,
      args,
      stdout,
      stderr
    };
  } catch (error) {
    const context = error instanceof CommandExecutionError ? error.context : undefined;

    throw new NpmCommandError(
      `npm command failed: ${command} ${args.join(" ")}`,
      {
        command,
        args,
        stdout: context?.stdout ?? "",
        stderr: context?.stderr ?? "",
        exitCode: context?.exitCode
      }
    );
  }
}
