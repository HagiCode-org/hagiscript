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
const bindPort = process.env.CODE_SERVER_BIND_PORT ?? "8080"
const bindHost = process.env.CODE_SERVER_BIND_HOST ?? "127.0.0.1"
await materializeTemplate(
  "code-server-config.yaml",
  configPath,
  {
    BIND_ADDR: quoteYamlString(`${bindHost}:${bindPort}`),
    DATA_DIR: quoteYamlString(context.runtimeDataHome),
    EXTENSIONS_DIR: quoteYamlString(path.join(context.runtimeDataHome, "extensions"))
  },
  path.join(currentRoot, "templates")
)
process.stdout.write(`Configured code-server template at ${configPath}\n`)
