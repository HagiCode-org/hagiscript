#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { runProcess } from "./process-runner.mjs";

const [logPath, rawCommand, ...args] = process.argv.slice(2);

if (!logPath || !rawCommand) {
  process.stderr.write(
    "Usage: node scripts/run-with-log.mjs <log-path> <command> [...args]\n"
  );
  process.exit(2);
}

const command =
  process.platform === "win32" && rawCommand === "npm" ? "npm.cmd" : rawCommand;

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const stream = fs.createWriteStream(logPath, { flags: "a" });

try {
  await runProcess(command, args, {
    env: withLocalBin(process.env),
    stdout: "inherit",
    stderr: "inherit",
    onStdout: (chunk) => stream.write(chunk),
    onStderr: (chunk) => stream.write(chunk)
  });
} catch (error) {
  if (typeof error.exitCode === "number") {
    process.exitCode = error.exitCode;
  } else if (error.signal) {
    process.stderr.write(`Command terminated by signal ${error.signal}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  stream.end();
}

function withLocalBin(env) {
  const nextEnv = { ...env };
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = nextEnv[pathKey] ?? nextEnv.PATH ?? "";
  nextEnv[pathKey] = [path.resolve("node_modules", ".bin"), currentPath]
    .filter(Boolean)
    .join(path.delimiter);
  return nextEnv;
}
