#!/usr/bin/env node
import { chmod, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import {
  ensureDirectory,
  readRuntimeScriptContext,
  writeComponentMarker
} from "../lib/runtime-script-lib.mjs"
import {
  installManagedDotnetRuntime
} from "../../dist/runtime/dotnet-installer.js"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const dotnetPath = path.join(currentRoot, process.platform === "win32" ? "dotnet.exe" : "dotnet")
const wrapperPath = path.join(context.binDir, process.platform === "win32" ? "dotnet.cmd" : "dotnet")
const dotnetVersion = context.componentVersion ?? "10.0.5"

await rm(currentRoot, { recursive: true, force: true })
await ensureDirectory(currentRoot)
await installManagedDotnetRuntime({
  targetDirectory: currentRoot,
  version: dotnetVersion,
  scriptBaseUrl: process.env.HAGISCRIPT_DOTNET_INSTALL_SCRIPT_BASE_URL?.trim() || undefined,
  verbose: process.env.HAGISCRIPT_RUNTIME_VERBOSE === "1"
})
await writeFile(path.join(currentRoot, "runtime-manifest.json"), `${JSON.stringify({
  component: context.componentName,
  channelVersion: context.componentVersion,
  installedVersion: dotnetVersion,
  runtimeRoot: context.runtimeRoot,
  dotnetPath
}, null, 2)}\n`, "utf8")
await writeDotnetWrapper(wrapperPath, dotnetPath)
await writeComponentMarker(context, {
  currentRoot,
  dotnetPath,
  wrapperPath,
  runtimeVersion: dotnetVersion,
  ownership: "hagiscript-managed"
})
process.stdout.write(`Installed .NET and ASP.NET Core runtime ${dotnetVersion} in ${currentRoot}\n`)

async function writeDotnetWrapper(destinationPath, targetPath) {
  await ensureDirectory(path.dirname(destinationPath))

  if (process.platform === "win32") {
    const relativeTarget = path.relative(path.dirname(destinationPath), targetPath).replaceAll("/", "\\")
    await writeFile(
      destinationPath,
      `@echo off\r\n"%~dp0\\${relativeTarget}" %*\r\n`,
      "utf8"
    )
    return
  }

  const relativeTarget = path.relative(path.dirname(destinationPath), targetPath).replaceAll("\\", "/")
  await writeFile(
    destinationPath,
    `#!/usr/bin/env sh
exec "$(dirname "$0")/${relativeTarget}" "$@"
`,
    "utf8"
  )
  await chmod(destinationPath, 0o755)
}
