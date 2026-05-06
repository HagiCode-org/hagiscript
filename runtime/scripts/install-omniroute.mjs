#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  ensureDirectory,
  materializeTemplate,
  readRuntimeScriptContext,
  writeCommandWrapper,
  writeComponentMarker,
  writeManagedServiceEntrypoint
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const launcherPath = path.join(currentRoot, "omniroute-launcher.mjs")
const configPath = path.join(context.componentConfigDir, "config.yaml")

await ensureDirectory(currentRoot)
await materializeTemplate("omniroute-config.yaml", configPath, {
  RUNTIME_ROOT: context.runtimeHome,
  DATA_DIR: context.runtimeDataHome,
  LOGS_DIR: context.componentLogsDir
})
await writeManagedServiceEntrypoint(
  launcherPath,
  "omniroute"
)
await writeCommandWrapper(context.binDir, "omniroute", launcherPath)
await writeComponentMarker(context, {
  configPath,
  launcherPath,
  runtimeHome: context.runtimeHome,
  runtimeDataHome: context.runtimeDataHome,
  pm2Home: context.componentPm2Home,
  ownership: "vendored-runtime"
})
process.stdout.write(`Prepared omniroute assets in ${currentRoot}\n`)
