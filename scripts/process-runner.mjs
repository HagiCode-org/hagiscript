import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
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
  const execa = await loadExeca();
  if (!execa) {
    return runProcessBootstrap(command, args, options);
  }

  const stdoutMode = options.stdout ?? "pipe";
  const stderrMode = options.stderr ?? "pipe";
  const subprocess = execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    windowsHide: true,
    reject: false,
    all: false,
    lines: false,
    buffer: true
  });

  subprocess.stdout?.on("data", (chunk) => {
    if (stdoutMode === "inherit") {
      process.stdout.write(chunk);
    }

    options.onStdout?.(chunk);
  });

  subprocess.stderr?.on("data", (chunk) => {
    if (stderrMode === "inherit") {
      process.stderr.write(chunk);
    }

    options.onStderr?.(chunk);
  });

  let executionResult;
  try {
    executionResult = await subprocess;
  } catch (error) {
    throw normalizeProcessError(command, args, options.cwd, error);
  }

  const result = {
    command,
    args,
    cwd: options.cwd ?? executionResult.cwd,
    stdout: stdoutMode === "ignore" ? "" : executionResult.stdout,
    stderr: stderrMode === "ignore" ? "" : executionResult.stderr,
    exitCode: executionResult.exitCode,
    signal: executionResult.signal
  };

  if (executionResult.exitCode !== 0 || executionResult.signal) {
    throw new ProcessRunError(formatFailureMessage(result), result);
  }

  return result;
}

async function loadExeca() {
  if (process.env.HAGISCRIPT_DISABLE_EXECA === "1") {
    return undefined;
  }

  try {
    return (await import("execa")).execa;
  } catch (error) {
    if (isMissingExecaError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingExecaError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes("Cannot find package 'execa'")
  );
}

async function runProcessBootstrap(command, args = [], options = {}) {
  const stdoutMode = options.stdout ?? "pipe";
  const stderrMode = options.stderr ?? "pipe";
  const subprocess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    windowsHide: true,
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

function normalizeProcessError(command, args, cwd, error) {
  const result = {
    command,
    args,
    cwd,
    stdout: typeof error.stdout === "string" ? error.stdout : "",
    stderr: typeof error.stderr === "string" ? error.stderr : "",
    exitCode: error.exitCode,
    signal: error.signal
  };

  return new ProcessRunError(
    error.shortMessage ?? error.message ?? formatFailureMessage(result),
    result
  );
}

function formatFailureMessage({ command, args, exitCode, signal }) {
  const commandLine = [command, ...args].join(" ");

  if (signal) {
    return `Command terminated by signal ${signal}: ${commandLine}`;
  }

  return `Command failed with exit code ${exitCode}: ${commandLine}`;
}

function waitForSubprocess(subprocess) {
  return new Promise((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("close", (code, signal) => resolve({ code, signal }));
  });
}
