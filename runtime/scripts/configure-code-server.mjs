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
  "code-server-config.yaml",
  configPath,
  {
    DATA_DIR: context.runtimeDataHome
  },
  path.join(currentRoot, "templates")
)
process.stdout.write(`Configured code-server template at ${configPath}\n`)
