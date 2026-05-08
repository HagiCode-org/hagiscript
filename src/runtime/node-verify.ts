import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants } from "node:fs";
import {
  CommandExecutionError,
  getCommandLaunchOptions,
  runCommand as defaultRunCommand
} from "./command-launch.js";

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
    timeoutMs: number,
    launchOptions?: { shell?: boolean }
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
      runCommand(paths.nodePath, ["--version"], timeoutMs, {
        ...getCommandLaunchOptions(paths.nodePath, { platform: options.platform })
      }),
      runCommand(paths.npmPath, ["--version"], timeoutMs, {
        ...getCommandLaunchOptions(paths.npmPath, { platform: options.platform })
      })
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
  timeoutMs: number,
  launchOptions: { shell?: boolean } = {}
): Promise<string> {
  try {
    const { stdout } = await defaultRunCommand(command, args, {
      timeoutMs,
      env: prependExecutableDirectoryToPath(command),
      shell: launchOptions.shell,
      maxBuffer: 1024 * 1024
    });

    return stdout;
  } catch (error) {
    const stderr =
      error instanceof CommandExecutionError ? error.context.stderr.trim() : "";
    throw new Error(
      stderr.length > 0
        ? stderr
        : `Command failed: ${command} ${args.join(" ")}`
    );
  }
}

function prependExecutableDirectoryToPath(
  command: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const executableDirectory = dirname(command);
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const existingPath = process.platform === "win32" ? (baseEnv.Path ?? baseEnv.PATH ?? "") : (baseEnv.PATH ?? "");

  return {
    ...baseEnv,
    [pathKey]: [executableDirectory, existingPath].filter(Boolean).join(
      process.platform === "win32" ? ";" : ":"
    )
  };
}
