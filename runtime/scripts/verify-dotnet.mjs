#!/usr/bin/env node
import path from "node:path"
import { access } from "node:fs/promises"
import process from "node:process"
import { readRuntimeScriptContext } from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const markerPath = path.join(context.componentRoot, ".hagicode-runtime.json")
await access(markerPath)
process.stdout.write(`Verified .NET runtime marker at ${markerPath}\n`)
