#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  ensureDirectory,
  readRuntimeScriptContext,
  writeComponentMarker
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const dllRelativePath = requiredEnv("HAGISCRIPT_RUNTIME_RELEASED_SERVICE_DLL_PATH")
const workingDirectoryRelativePath = requiredEnv(
  "HAGISCRIPT_RUNTIME_RELEASED_SERVICE_WORKING_DIRECTORY"
)
const dllPath = path.join(context.componentRoot, dllRelativePath)
const workingDirectory = path.join(context.componentRoot, workingDirectoryRelativePath)
const payloadExists = await pathExists(dllPath)
const workingDirectoryExists = await pathExists(workingDirectory)

await ensureDirectory(context.componentRoot)
await writeComponentMarker(context, {
  ownership: "released-service",
  dllPath,
  workingDirectory,
  payloadExists,
  workingDirectoryExists,
  runtimeHome: context.runtimeHome,
  runtimeDataHome: context.runtimeDataHome,
  pm2Home: context.componentPm2Home
})
process.stdout.write(
  payloadExists && workingDirectoryExists
    ? `Validated released server payload at ${dllPath}\n`
    : `Released server payload is not staged yet; expected ${dllPath}\n`
)

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing runtime script environment variable: ${name}`)
  }

  return value
}

async function pathExists(pathValue) {
  try {
    await ensureDirectory(path.dirname(pathValue))
    await import("node:fs/promises").then(({ access }) => access(pathValue))
    return true
  } catch {
    return false
  }
}
