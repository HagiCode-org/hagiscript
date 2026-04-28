import { execa } from "execa";

export interface CommandLaunchOptions {
  platform?: NodeJS.Platform;
}

export interface RuntimeExecFileOptions {
  shell?: boolean;
}

export interface CommandRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shell?: boolean;
  maxBuffer?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  cwd?: string;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
}

export interface CommandFailureContext extends CommandResult {
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  failed: boolean;
  shortMessage?: string;
}

export type CommandRunner = (
  // Keep executable and arguments separate so execa preserves argv boundaries.
  command: string,
  args: string[],
  options?: CommandRunnerOptions
) => Promise<CommandResult>;

export class CommandExecutionError extends Error {
  readonly context: CommandFailureContext;

  constructor(message: string, context: CommandFailureContext, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandExecutionError";
    this.context = context;
  }
}

export function normalizeCommandPath(commandPath: string): string {
  const trimmed = commandPath.trim();

  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];

    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

export function requiresShellLaunch(
  _commandPath: string,
  _platform: NodeJS.Platform = process.platform
): boolean {
  // Execa already handles Windows command shims without a shell wrapper.
  // Keeping direct execution preserves argv boundaries for paths with spaces.
  return false;
}

export function getCommandLaunchOptions(
  commandPath: string,
  options: CommandLaunchOptions = {}
): RuntimeExecFileOptions {
  return requiresShellLaunch(commandPath, options.platform)
    ? { shell: true }
    : {};
}

export const runCommand: CommandRunner = async (
  command,
  args,
  options = {}
) => {
  try {
    const result = await execa(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      shell: options.shell,
      windowsHide: true,
      maxBuffer: options.maxBuffer,
      stdout: "pipe",
      stderr: "pipe"
    });

    return {
      command,
      args,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(result.stderr),
      cwd: result.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut
    };
  } catch (error) {
    throw normalizeCommandError(command, args, error, options);
  }
};

function normalizeCommandError(
  command: string,
  args: string[],
  error: unknown,
  options: CommandRunnerOptions
): CommandExecutionError {
  const execaError = error as Partial<CommandFailureContext> & {
    message?: string;
    shortMessage?: string;
    cwd?: string;
    code?: string;
  };
  const stdout = normalizeOutput(execaError.stdout);
  const stderr = normalizeOutput(execaError.stderr);
  const shortMessage = execaError.shortMessage ?? execaError.message;
  const timedOut = execaError.timedOut === true;
  const exitCode = typeof execaError.exitCode === "number" ? execaError.exitCode : undefined;
  const signal = typeof execaError.signal === "string" ? execaError.signal : undefined;
  const failed = execaError.failed !== false;

  return new CommandExecutionError(
    shortMessage ?? `Command failed: ${command} ${args.join(" ")}`,
    {
      command,
      args,
      stdout,
      stderr,
      cwd: typeof execaError.cwd === "string" ? execaError.cwd : options.cwd,
      exitCode,
      signal,
      timedOut,
      failed,
      shortMessage
    },
    error instanceof Error ? { cause: error } : undefined
  );
}

function normalizeOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (Buffer.isBuffer(output)) {
    return output.toString("utf8");
  }

  return "";
}
