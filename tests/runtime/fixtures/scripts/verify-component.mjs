#!/usr/bin/env node

import { access } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const componentName = requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_NAME")
const componentRoot = requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_ROOT")
const componentConfigDir = requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_CONFIG_DIR")

await access(path.join(componentRoot, "current", `${componentName}.txt`))
await access(path.join(componentConfigDir, "config.txt"))
process.stdout.write(`verified ${componentName}\n`)

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required env: ${name}`)
  }

  return value
}
