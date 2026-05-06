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
const launcherPath = path.join(currentRoot, "code-server-launcher.mjs")
const configPath = path.join(context.componentConfigDir, "config.yaml")

await ensureDirectory(currentRoot)
await materializeTemplate("code-server-config.yaml", configPath, {
  DATA_DIR: context.runtimeDataHome
})
await writeManagedServiceEntrypoint(
  launcherPath,
  "code-server"
)
await writeCommandWrapper(context.binDir, "code-server", launcherPath)
await writeComponentMarker(context, {
  configPath,
  launcherPath,
  runtimeHome: context.runtimeHome,
  runtimeDataHome: context.runtimeDataHome,
  pm2Home: context.componentPm2Home,
  ownership: "vendored-runtime"
})
process.stdout.write(`Prepared code-server assets in ${currentRoot}\n`)
