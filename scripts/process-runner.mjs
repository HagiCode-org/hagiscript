import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { extname } from "node:path";
import process from "node:process";

export class ProcessRunError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "ProcessRunError";
    this.result = result;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
  }
}

export async function runProcess(command, args = [], options = {}) {
  const stdoutMode = options.stdout ?? "pipe";
  const stderrMode = options.stderr ?? "pipe";
  const spawnSpec = createSpawnSpec(command, args, options);
  const subprocess = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.cwd,
    env: options.env,
    shell: spawnSpec.shell,
    windowsHide: true,
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdoutChunks = [];
  const stderrChunks = [];

  subprocess.stdout?.on("data", (chunk) => {
    if (stdoutMode !== "ignore") {
      stdoutChunks.push(Buffer.from(chunk));
    }

    if (stdoutMode === "inherit") {
      process.stdout.write(chunk);
    }

    options.onStdout?.(chunk);
  });

  subprocess.stderr?.on("data", (chunk) => {
    if (stderrMode !== "ignore") {
      stderrChunks.push(Buffer.from(chunk));
    }

    if (stderrMode === "inherit") {
      process.stderr.write(chunk);
    }

    options.onStderr?.(chunk);
  });

  const { code, signal } = await waitForSubprocess(subprocess);
  const result = {
    command,
    args,
    cwd: options.cwd,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode: code,
    signal
  };

  if (code !== 0 || signal) {
    throw new ProcessRunError(formatFailureMessage(result), result);
  }

  return result;
}

export function createSpawnSpec(
  command,
  args = [],
  options = {},
  platform = process.platform
) {
  const shell = options.shell ?? requiresShell(command, platform);

  if (platform === "win32" && requiresShell(command, platform)) {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", formatWindowsBatchCommand(command, args)],
      shell: false,
      windowsVerbatimArguments: true
    };
  }

  return {
    command,
    args,
    shell,
    windowsVerbatimArguments: false
  };
}

export function requiresShell(command, platform = process.platform) {
  if (platform !== "win32") {
    return false;
  }

  const extension = extname(command.replace(/^['"]|['"]$/g, "")).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function formatWindowsBatchCommand(command, args) {
  const quotedCommand = quoteWindowsBatchArgument(command);
  const quotedArgs = args.map(quoteWindowsBatchArgument).join(" ");
  return quotedArgs.length > 0
    ? `"${quotedCommand} ${quotedArgs}"`
    : `"${quotedCommand}"`;
}

function quoteWindowsBatchArgument(value) {
  if (value.length === 0) {
    return '""';
  }

  const escaped = value.replace(/(["^&|<>()%!])/g, "^$1");
  return /[\s"]/u.test(value) ? `"${escaped}"` : escaped;
}

function waitForSubprocess(subprocess) {
  return new Promise((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function formatFailureMessage({ command, args, exitCode, signal }) {
  const commandLine = [command, ...args].join(" ");

  if (signal) {
    return `Command terminated by signal ${signal}: ${commandLine}`;
  }

  return `Command failed with exit code ${exitCode}: ${commandLine}`;
}
