#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const [logPath, rawCommand, ...args] = process.argv.slice(2);

if (!logPath || !rawCommand) {
  process.stderr.write("Usage: node scripts/run-with-log.mjs <log-path> <command> [...args]\n");
  process.exit(2);
}

const command = process.platform === "win32" && rawCommand === "npm" ? "npm.cmd" : rawCommand;

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const stream = fs.createWriteStream(logPath, { flags: "a" });

try {
  const subprocess = spawn(command, args, {
    env: withLocalBin(process.env),
    stdio: ["ignore", "pipe", "pipe"]
  });

  subprocess.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    stream.write(chunk);
  });

  subprocess.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    stream.write(chunk);
  });

  const { code, signal } = await waitForSubprocess(subprocess);

  if (signal) {
    process.stderr.write(`Command terminated by signal ${signal}\n`);
    process.exitCode = 1;
  } else if (code !== 0) {
    process.exitCode = code ?? 1;
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

function waitForSubprocess(subprocess) {
  return new Promise((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("close", (code, signal) => resolve({ code, signal }));
  });
}
