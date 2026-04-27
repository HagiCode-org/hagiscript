#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execa } from "execa";

const [logPath, rawCommand, ...args] = process.argv.slice(2);

if (!logPath || !rawCommand) {
  process.stderr.write("Usage: node scripts/run-with-log.mjs <log-path> <command> [...args]\n");
  process.exit(2);
}

const command = process.platform === "win32" && rawCommand === "npm" ? "npm.cmd" : rawCommand;

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const stream = fs.createWriteStream(logPath, { flags: "a" });

try {
  const subprocess = execa(command, args, {
    stdout: "pipe",
    stderr: "pipe",
    preferLocal: true
  });

  subprocess.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    stream.write(chunk);
  });

  subprocess.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    stream.write(chunk);
  });

  await subprocess;
} finally {
  stream.end();
}
