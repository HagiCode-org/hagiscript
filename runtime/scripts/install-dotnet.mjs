#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  ensureDirectory,
  readRuntimeScriptContext,
  writeComponentMarker,
  writeJsonFile
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")

await ensureDirectory(currentRoot)
await writeJsonFile(path.join(currentRoot, "runtime-manifest.json"), {
  component: context.componentName,
  channelVersion: context.componentVersion,
  runtimeRoot: context.runtimeRoot
})
await writeComponentMarker(context, {
  currentRoot,
  ownership: "hagiscript-managed"
})
process.stdout.write(`Prepared .NET runtime placeholder in ${currentRoot}\n`)
