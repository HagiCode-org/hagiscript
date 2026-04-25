import { access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RuntimeExecutablePaths {
  nodePath: string;
  npmPath: string;
}

export interface NodeRuntimeVerificationResult {
  valid: boolean;
  targetDirectory: string;
  nodeVersion?: string;
  npmVersion?: string;
  nodePath?: string;
  npmPath?: string;
  failureReason?: string;
}

export interface VerifyNodeRuntimeOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runCommand?: (
    command: string,
    args: string[],
    timeoutMs: number
  ) => Promise<string>;
}

export async function verifyNodeRuntime(
  targetDirectory: string,
  options: VerifyNodeRuntimeOptions = {}
): Promise<NodeRuntimeVerificationResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const runCommand = options.runCommand ?? runVersionCommand;
  const paths = getRuntimeExecutablePaths(targetDirectory, options.platform);

  try {
    await access(paths.nodePath, constants.X_OK);
    await access(paths.npmPath, constants.X_OK);

    const [nodeVersion, npmVersion] = await Promise.all([
      runCommand(paths.nodePath, ["--version"], timeoutMs),
      runCommand(paths.npmPath, ["--version"], timeoutMs)
    ]);

    return {
      valid: true,
      targetDirectory,
      nodeVersion: nodeVersion.trim(),
      npmVersion: npmVersion.trim(),
      nodePath: paths.nodePath,
      npmPath: paths.npmPath
    };
  } catch (error) {
    return {
      valid: false,
      targetDirectory,
      nodePath: paths.nodePath,
      npmPath: paths.npmPath,
      failureReason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function getRuntimeExecutablePaths(
  targetDirectory: string,
  platform: NodeJS.Platform = process.platform
): RuntimeExecutablePaths {
  if (platform === "win32") {
    return {
      nodePath: join(targetDirectory, "node.exe"),
      npmPath: join(targetDirectory, "npm.cmd")
    };
  }

  return {
    nodePath: join(targetDirectory, "bin", "node"),
    npmPath: join(targetDirectory, "bin", "npm")
  };
}

async function runVersionCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    return stdout;
  } catch (error) {
    const execError = error as ExecFileException;
    const stderr =
      typeof execError.stderr === "string" ? execError.stderr.trim() : "";
    throw new Error(
      stderr.length > 0
        ? stderr
        : `Command failed: ${command} ${args.join(" ")}`
    );
  }
}
