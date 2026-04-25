import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  runCommand?: (
    command: string,
    args: string[],
    timeoutMs: number
  ) => Promise<NpmCommandResult>;
}

export async function listGlobalPackages(
  npmPath: string,
  options: NpmGlobalCommandOptions = {}
): Promise<NpmCommandResult> {
  return runNpmCommand(npmPath, ["list", "-g", "--depth=0", "--json"], options);
}

export async function installGlobalPackage(
  npmPath: string,
  selector: string,
  options: NpmGlobalCommandOptions = {}
): Promise<NpmCommandResult> {
  return runNpmCommand(npmPath, ["install", "-g", selector], options);
}

async function runNpmCommand(
  npmPath: string,
  args: string[],
  options: NpmGlobalCommandOptions
): Promise<NpmCommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const runner = options.runCommand
    ? options.runCommand
    : (command: string, commandArgs: string[], commandTimeoutMs: number) =>
        execNpmCommand(command, commandArgs, commandTimeoutMs, options.env);

  return runner(npmPath, args, timeoutMs);
}

async function execNpmCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<NpmCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      env,
      maxBuffer: 10 * 1024 * 1024
    });

    return {
      command,
      args,
      stdout,
      stderr
    };
  } catch (error) {
    const execError = error as ExecFileException;
    const stdout = typeof execError.stdout === "string" ? execError.stdout : "";
    const stderr = typeof execError.stderr === "string" ? execError.stderr : "";

    throw new NpmCommandError(
      `npm command failed: ${command} ${args.join(" ")}`,
      {
        command,
        args,
        stdout,
        stderr,
        exitCode: execError.code
      }
    );
  }
}
