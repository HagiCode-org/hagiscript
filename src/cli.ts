#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createRuntimeInfo, packageVersion } from "./index.js";
import { registerNpmSyncCommand } from "./commands/npm-sync-commands.js";
import { registerNodeRuntimeCommands } from "./commands/node-runtime-commands.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("hagiscript")
    .description("Hagiscript language tooling CLI foundation.")
    .version(packageVersion, "-v, --version", "print the hagiscript version");

  program
    .command("info")
    .description("print package foundation metadata")
    .action(() => {
      const info = createRuntimeInfo();
      process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    });

  registerNodeRuntimeCommands(program);
  registerNpmSyncCommand(program);

  program.action(() => {
    program.outputHelp();
  });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createCli();
  await program.parseAsync(argv);
}

export function isCliEntrypoint(
  moduleUrl = import.meta.url,
  argvPath = process.argv[1]
): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
