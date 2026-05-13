#!/usr/bin/env node
import process from "node:process"
import { readRuntimeScriptContext, runManagedCommand } from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const npmExecPath = process.env.npm_execpath?.trim()

if (!npmExecPath) {
  throw new Error("Missing npm_execpath for managed pm2 removal")
}

try {
  await runManagedCommand(
    npmExecPath,
    ["uninstall", "--global", "pm2", "--prefix", context.runtimeNpmPrefix],
    {
      env: process.env,
      cwd: context.runtimeHome
    }
  )
} catch {
  process.stdout.write(`pm2 uninstall skipped for ${context.runtimeNpmPrefix}\n`)
}

process.stdout.write(`Removed pm2 from ${context.runtimeNpmPrefix}\n`)