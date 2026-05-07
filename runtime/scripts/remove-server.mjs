#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import { rm } from "node:fs/promises"

const runtimeDataHome = requiredEnv("HAGICODE_RUNTIME_DATA_HOME")
const runtimeFilesDir = path.join(
  runtimeDataHome,
  process.env.HAGISCRIPT_RUNTIME_RELEASED_SERVICE_RUNTIME_FILES_DIR?.trim() || "pm2-runtime"
)

await rm(runtimeFilesDir, { recursive: true, force: true })
process.stdout.write(`Removed released server PM2 assets from ${runtimeFilesDir}\n`)

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing runtime script environment variable: ${name}`)
  }

  return value
}
