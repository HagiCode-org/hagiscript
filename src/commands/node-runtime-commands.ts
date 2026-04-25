import { Command, InvalidArgumentError } from "commander";
import { installNodeRuntime } from "../runtime/node-installer.js";
import { validateVersionSelector } from "../runtime/node-release.js";
import { verifyNodeRuntime } from "../runtime/node-verify.js";

interface InstallNodeOptions {
  target?: string;
  version?: string;
}

interface CheckNodeOptions {
  target?: string;
}

export function registerNodeRuntimeCommands(program: Command): void {
  program
    .command("install-node")
    .description("install an official Node.js runtime into a target directory")
    .requiredOption(
      "--target <path>",
      "empty target directory for the managed runtime"
    )
    .option(
      "--version <selector>",
      "Node.js selector: lts, latest, current, 22, 22.11.0, or v22.11.0",
      validateVersionOption
    )
    .action(async (options: InstallNodeOptions, command: Command) => {
      const target = validateTargetOption(options.target);
      const versionSelector = options.version;

      try {
        process.stdout.write(
          `Installing Node.js ${versionSelector ?? "22"} into ${target}\n`
        );
        const result = await installNodeRuntime({
          targetDirectory: target,
          versionSelector,
          onProgress: (progress) => {
            if (progress.totalBytes && progress.totalBytes > 0) {
              const percent = Math.floor(
                (progress.receivedBytes / progress.totalBytes) * 100
              );
              process.stdout.write(`Download progress: ${percent}%\r`);
            } else {
              process.stdout.write(
                `Downloaded ${progress.receivedBytes} bytes\r`
              );
            }
          }
        });
        process.stdout.write("\n");
        process.stdout.write(`Node.js runtime installed successfully.\n`);
        process.stdout.write(`Target: ${result.targetDirectory}\n`);
        process.stdout.write(`Node.js: ${result.version}\n`);
        process.stdout.write(`npm: ${result.npmVersion}\n`);
        process.stdout.write(`node: ${result.nodePath}\n`);
        process.stdout.write(`npm: ${result.npmPath}\n`);
      } catch (error) {
        command.error(formatCommandError("install-node failed", error), {
          exitCode: 1
        });
      }
    });

  program
    .command("check-node")
    .description("validate an existing HagicScript-managed Node.js runtime")
    .requiredOption("--target <path>", "target runtime directory to validate")
    .action(async (options: CheckNodeOptions, command: Command) => {
      const target = validateTargetOption(options.target);
      const result = await verifyNodeRuntime(target);

      if (!result.valid) {
        process.stderr.write(`Node.js runtime is invalid.\n`);
        process.stderr.write(`Target: ${result.targetDirectory}\n`);
        process.stderr.write(
          `Reason: ${result.failureReason ?? "unknown failure"}\n`
        );
        command.error("check-node failed", { exitCode: 1 });
        return;
      }

      process.stdout.write(`Node.js runtime is valid.\n`);
      process.stdout.write(`Target: ${result.targetDirectory}\n`);
      process.stdout.write(`Node.js: ${result.nodeVersion}\n`);
      process.stdout.write(`npm: ${result.npmVersion}\n`);
      process.stdout.write(`node: ${result.nodePath}\n`);
      process.stdout.write(`npm: ${result.npmPath}\n`);
    });
}

function validateVersionOption(value: string): string {
  try {
    validateVersionSelector(value);
    return value;
  } catch (error) {
    throw new InvalidArgumentError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

function validateTargetOption(value: string | undefined): string {
  const target = value?.trim();
  if (!target) {
    throw new InvalidArgumentError("--target must be a non-empty path.");
  }

  if (target.includes("\0")) {
    throw new InvalidArgumentError("--target contains an invalid null byte.");
  }

  return target;
}

function formatCommandError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}
