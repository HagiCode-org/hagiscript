#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  ensureDirectory,
  materializeTemplate,
  readRuntimeScriptContext,
  writeCommandWrapper,
  writeComponentMarker,
  writeNodeEntrypoint
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const launcherPath = path.join(currentRoot, "omniroute-launcher.mjs")
const configPath = path.join(context.componentConfigDir, "config.yaml")

await ensureDirectory(currentRoot)
await materializeTemplate("omniroute-config.yaml", configPath, {
  RUNTIME_ROOT: context.runtimeRoot,
  DATA_DIR: context.dataDir,
  LOGS_DIR: context.logsDir
})
await writeNodeEntrypoint(
  launcherPath,
  `omniroute placeholder managed by hagiscript at ${context.runtimeRoot}`
)
await writeCommandWrapper(context.binDir, "omniroute", launcherPath)
await writeComponentMarker(context, {
  configPath,
  launcherPath,
  ownership: "vendored-runtime"
})
process.stdout.write(`Prepared omniroute assets in ${currentRoot}\n`)
