#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const componentName = requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_NAME")
const componentRoot = requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_ROOT")
const componentConfigDir = requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_CONFIG_DIR")
const templateDir = requiredEnv("HAGISCRIPT_RUNTIME_TEMPLATE_DIR")
const runtimeRoot = requiredEnv("HAGISCRIPT_RUNTIME_ROOT")
const phase = requiredEnv("HAGISCRIPT_RUNTIME_PHASE")

const currentRoot = path.join(componentRoot, "current")
const template = await readFile(path.join(templateDir, "service-template.txt"), "utf8")
const rendered = template
  .replaceAll("{{COMPONENT_NAME}}", componentName)
  .replaceAll("{{RUNTIME_ROOT}}", runtimeRoot)
  .replaceAll("{{PHASE}}", phase)

await mkdir(currentRoot, { recursive: true })
await mkdir(componentConfigDir, { recursive: true })
await writeFile(path.join(currentRoot, `${componentName}.txt`), `${componentName}:${phase}\n`, "utf8")
await writeFile(path.join(componentConfigDir, "config.txt"), rendered, "utf8")
process.stdout.write(`installed ${componentName}\n`)

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required env: ${name}`)
  }

  return value
}
