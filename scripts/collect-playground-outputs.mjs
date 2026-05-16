#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { execa } from "execa"

const repoRoot = process.cwd()
const outputsRoot = resolve(repoRoot, "playground", "outputs")
const manifestPath = "./playground/generated/manifest.yaml"
const runtimeRoot = "./playground/runtime-root"

await execa("npm", ["run", "playground:manifest:generate"], {
  cwd: repoRoot,
  stdio: "inherit"
})

const commands = [
  {
    outputPath: join(outputsRoot, "runtime-state.json"),
    command: [
      "npm",
      "run",
      "dev",
      "--",
      "runtime",
      "state",
      "--from-manifest",
      manifestPath,
      "--runtime-root",
      runtimeRoot,
      "--json"
    ]
  },
  {
    outputPath: join(outputsRoot, "server-status.json"),
    command: [
      "npm",
      "run",
      "dev",
      "--",
      "server",
      "status",
      "--from-manifest",
      manifestPath,
      "--runtime-root",
      runtimeRoot,
      "--json"
    ]
  },
  {
    outputPath: join(outputsRoot, "server-env.json"),
    command: [
      "npm",
      "run",
      "dev",
      "--",
      "server",
      "env",
      "--from-manifest",
      manifestPath,
      "--runtime-root",
      runtimeRoot,
      "--json"
    ]
  },
  {
    outputPath: join(outputsRoot, "omniroute-status.json"),
    command: [
      "npm",
      "run",
      "dev",
      "--",
      "pm2",
      "omniroute",
      "status",
      "--from-manifest",
      manifestPath,
      "--runtime-root",
      runtimeRoot,
      "--json"
    ]
  },
  {
    outputPath: join(outputsRoot, "code-server-status.json"),
    command: [
      "npm",
      "run",
      "dev",
      "--",
      "pm2",
      "code-server",
      "status",
      "--from-manifest",
      manifestPath,
      "--runtime-root",
      runtimeRoot,
      "--json"
    ]
  }
]

await mkdir(outputsRoot, { recursive: true })

let failed = false

for (const entry of commands) {
  const [command, ...args] = entry.command
  const result = await execa(command, args, {
    cwd: repoRoot,
    reject: false,
    all: true
  })

  await mkdir(dirname(entry.outputPath), { recursive: true })
  await writeFile(entry.outputPath, `${result.all ?? ""}\n`, "utf8")

  if (result.exitCode !== 0) {
    failed = true
    process.stderr.write(
      `Failed while collecting ${entry.outputPath}: ${command} ${args.join(" ")} exited with ${result.exitCode}\n`
    )
    continue
  }

  process.stdout.write(`Wrote ${entry.outputPath}\n`)
}

if (failed) {
  process.exitCode = 1
}
