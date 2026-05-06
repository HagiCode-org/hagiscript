#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  materializeTemplate,
  readRuntimeScriptContext
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const configPath = path.join(context.componentConfigDir, "config.yaml")
await materializeTemplate("omniroute-config.yaml", configPath, {
  RUNTIME_ROOT: context.runtimeRoot,
  DATA_DIR: context.dataDir,
  LOGS_DIR: context.logsDir
})
process.stdout.write(`Configured omniroute template at ${configPath}\n`)
