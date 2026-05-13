#!/usr/bin/env node
import process from "node:process"
import {
  ensureDirectory,
  readRuntimeScriptContext,
  runManagedCommand,
  writeComponentMarker
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const npmExecPath = process.env.npm_execpath?.trim()

if (!npmExecPath) {
  throw new Error("Missing npm_execpath for managed pm2 installation")
}

const versionSpec = context.pm2VersionOverride || context.componentVersion || "*"
const installSpec = versionSpec === "*" ? "pm2" : `pm2@${versionSpec}`
const args = ["install", "--global", installSpec, "--prefix", context.runtimeNpmPrefix]

if (context.npmRegistryMirror) {
  args.push("--registry", context.npmRegistryMirror)
}

await ensureDirectory(context.componentRoot)
await ensureDirectory(context.runtimeNpmPrefix)
await runManagedCommand(npmExecPath, args, {
  env: process.env,
  cwd: context.runtimeHome
})

await writeComponentMarker(context, {
  packageName: "pm2",
  installSpec,
  npmPrefix: context.runtimeNpmPrefix,
  ownership: "runtime-managed-package"
})

process.stdout.write(`Prepared pm2 in ${context.runtimeNpmPrefix}\n`)