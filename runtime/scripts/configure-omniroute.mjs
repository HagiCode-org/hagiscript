#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  materializeTemplate,
  readRuntimeScriptContext
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const configPath = path.join(context.componentConfigDir, "config.yaml")
await materializeTemplate(
  "omniroute-config.yaml",
  configPath,
  {
    RUNTIME_ROOT: context.runtimeHome,
    DATA_DIR: context.runtimeDataHome,
    LOGS_DIR: context.componentLogsDir
  },
  path.join(currentRoot, "templates")
)
process.stdout.write(`Configured omniroute template at ${configPath}\n`)
