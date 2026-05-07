#!/usr/bin/env node
import { rm } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { readRuntimeScriptContext } from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const wrapperPath = path.join(context.binDir, process.platform === "win32" ? "dotnet.cmd" : "dotnet")

await rm(context.componentRoot, { recursive: true, force: true })
await rm(wrapperPath, { force: true })

process.stdout.write(`Removed managed .NET runtime from ${context.componentRoot}\n`)
