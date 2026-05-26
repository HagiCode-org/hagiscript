#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  materializeTemplate,
  quoteYamlString,
  readRuntimeScriptContext
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const configPath = path.join(context.componentConfigDir, "config.yaml")
const listenPort = process.env.OMNIROUTE_LISTEN_PORT ?? "39001"
const listenHost = process.env.OMNIROUTE_LISTEN_HOST ?? "127.0.0.1"
const templateRoot =
  context.bundledInstallMode === "archive-7z-only"
    ? context.templateDir
    : path.join(currentRoot, "templates")
await materializeTemplate(
  "omniroute-config.yaml",
  configPath,
  {
    RUNTIME_ROOT: quoteYamlString(context.runtimeHome),
    LISTEN_ADDR: quoteYamlString(`${listenHost}:${listenPort}`),
    DATA_DIR: quoteYamlString(context.runtimeDataHome),
    LOGS_DIR: quoteYamlString(context.componentLogsDir)
  },
  templateRoot
)
process.stdout.write(`Configured omniroute template at ${configPath}\n`)
