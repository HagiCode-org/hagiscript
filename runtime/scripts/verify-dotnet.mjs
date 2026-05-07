#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  verifyManagedDotnetRuntime
} from "../../dist/runtime/dotnet-installer.js"
import { readRuntimeScriptContext } from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const version = context.componentVersion ?? "10.0.5"
const verification = await verifyManagedDotnetRuntime({
  targetDirectory: currentRoot,
  version
})

if (!verification.valid) {
  throw new Error(
    `Managed .NET runtime verification failed for ${currentRoot}: ${verification.failureReason ?? "unknown failure"}`
  )
}

process.stdout.write(
  `Verified managed .NET runtime ${version} at ${verification.dotnetPath}\n`
)
process.stdout.write(verification.listRuntimesOutput ?? "")
