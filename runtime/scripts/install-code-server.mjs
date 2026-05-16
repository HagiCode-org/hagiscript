#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  ensureDirectory,
  installVendoredPackage,
  materializeTemplate,
  quoteYamlString,
  readRuntimeScriptContext,
  writeCommandWrapper,
  writeComponentMarker
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const configPath = path.join(context.componentConfigDir, "config.yaml")
const extensionsPath = path.join(context.runtimeDataHome, "extensions")
const wrapperPath = path.join(
  currentRoot,
  "bin",
  process.platform === "win32" ? "code-server.cmd" : "code-server"
)

await ensureDirectory(currentRoot)
const installedPackage = await installVendoredPackage(context, {
  prefixRoot: currentRoot,
  packageName: "code-server",
  entrypointRelativePath: path.join("out", "node", "entry.js")
})
await materializeTemplate(
  "code-server-config.yaml",
  configPath,
  {
    BIND_ADDR: quoteYamlString("127.0.0.1:8080"),
    DATA_DIR: quoteYamlString(context.runtimeDataHome),
    EXTENSIONS_DIR: quoteYamlString(extensionsPath)
  },
  path.join(currentRoot, "templates")
)
await writeCommandWrapper(context.binDir, "code-server", wrapperPath, {
  baseArgs: ["--config", configPath]
})
await writeComponentMarker(context, {
  configPath,
  wrapperPath,
  entrypointPath: installedPackage.entrypointPath,
  vendoredReleaseRepository: installedPackage.releaseRepository,
  vendoredReleaseTag: installedPackage.releaseTag,
  vendoredReleaseName: installedPackage.releaseName,
  vendoredReleaseUrl: installedPackage.releaseUrl,
  vendoredAssetName: installedPackage.releaseAssetName,
  vendoredAssetUrl: installedPackage.releaseAssetUrl,
  runtimeHome: context.runtimeHome,
  runtimeDataHome: context.runtimeDataHome,
  pm2Home: context.componentPm2Home,
  ownership: "vendored-runtime"
})
process.stdout.write(`Prepared code-server assets in ${currentRoot}\n`)
