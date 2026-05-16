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
const wrapperPath = path.join(
  currentRoot,
  process.platform === "win32" ? "omniroute.cmd" : "omniroute.sh"
)

await ensureDirectory(currentRoot)
const installedPackage = await installVendoredPackage(context, {
  prefixRoot: currentRoot,
  packageName: "omniroute",
  entrypointRelativePath: path.join("bin", "omniroute.mjs")
})
await materializeTemplate(
  "omniroute-config.yaml",
  configPath,
  {
    RUNTIME_ROOT: quoteYamlString(context.runtimeHome),
    LISTEN_ADDR: quoteYamlString("127.0.0.1:39001"),
    DATA_DIR: quoteYamlString(context.runtimeDataHome),
    LOGS_DIR: quoteYamlString(context.componentLogsDir)
  },
  path.join(currentRoot, "templates")
)
await writeCommandWrapper(context.binDir, "omniroute", wrapperPath, {
  baseArgs: ["--config", configPath, "--no-open"]
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
process.stdout.write(`Prepared omniroute assets in ${currentRoot}\n`)
