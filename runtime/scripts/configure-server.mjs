#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import { writeFile } from "node:fs/promises"
import {
  ensureDirectory,
  readRuntimeScriptContext
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const runtimeFilesDir = path.join(
  context.runtimeDataHome,
  process.env.HAGISCRIPT_RUNTIME_RELEASED_SERVICE_RUNTIME_FILES_DIR?.trim() || "pm2-runtime"
)
const dllPath = resolveReleasedServicePath(
  "HAGISCRIPT_RUNTIME_RELEASED_SERVICE_DLL_ABSOLUTE_PATH",
  "HAGISCRIPT_RUNTIME_RELEASED_SERVICE_DLL_PATH",
  context.componentRoot
)
const workingDirectory = resolveReleasedServicePath(
  "HAGISCRIPT_RUNTIME_RELEASED_SERVICE_WORKING_DIRECTORY_ABSOLUTE_PATH",
  "HAGISCRIPT_RUNTIME_RELEASED_SERVICE_WORKING_DIRECTORY",
  context.componentRoot
)
const dotnetExecutable = path.join(
  requiredEnv("HAGISCRIPT_RUNTIME_DOTNET_RUNTIME_DIR"),
  "current",
  process.platform === "win32" ? "dotnet.exe" : "dotnet"
)
const launchContractPath = path.join(runtimeFilesDir, "launch-contract.json")

await ensureDirectory(runtimeFilesDir)
await writeFile(
  launchContractPath,
  `${JSON.stringify(
    {
      component: context.componentName,
      runtimeHome: context.runtimeHome,
      runtimeDataHome: context.runtimeDataHome,
      pm2Home: context.componentPm2Home,
      dotnetExecutable,
      dllPath,
      workingDirectory,
      generatedAt: new Date().toISOString()
    },
    null,
    2
  )}\n`,
  "utf8"
)
process.stdout.write(`Prepared released server PM2 assets in ${runtimeFilesDir}\n`)

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing runtime script environment variable: ${name}`)
  }

  return value
}

function resolveReleasedServicePath(absoluteEnvName, legacyEnvName, componentRoot) {
  const absolutePath = process.env[absoluteEnvName]?.trim()
  if (absolutePath) {
    return path.resolve(absolutePath)
  }

  return path.resolve(componentRoot, requiredEnv(legacyEnvName))
}
