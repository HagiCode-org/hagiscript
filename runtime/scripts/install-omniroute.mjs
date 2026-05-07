#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import {
  ensureDirectory,
  installVendoredPackage,
  materializeTemplate,
  readRuntimeScriptContext,
  writeCommandWrapper,
  writeComponentMarker,
  writeManagedPackageLauncher
} from "../lib/runtime-script-lib.mjs"

const context = readRuntimeScriptContext()
const currentRoot = path.join(context.componentRoot, "current")
const launcherPath = path.join(currentRoot, "omniroute-launcher.mjs")
const configPath = path.join(context.componentConfigDir, "config.yaml")

await ensureDirectory(currentRoot)
await materializeTemplate("omniroute-config.yaml", configPath, {
  RUNTIME_ROOT: context.runtimeHome,
  DATA_DIR: context.runtimeDataHome,
  LOGS_DIR: context.componentLogsDir
})
const installedPackage = await installVendoredPackage(context, {
  prefixRoot: currentRoot,
  packageName: "omniroute",
  entrypointRelativePath: path.join("bin", "omniroute.mjs")
})
await writeManagedPackageLauncher(
  launcherPath,
  {
    entrypointPath: installedPackage.entrypointPath,
    configPath,
    baseArgs: ["--no-open"],
    defaultEnv: {
      DATA_DIR: context.runtimeDataHome,
      LOG_DIR: context.componentLogsDir,
      PORT: "39001"
    },
    serviceKind: "omniroute"
  }
)
await writeCommandWrapper(context.binDir, "omniroute", launcherPath)
await writeComponentMarker(context, {
  configPath,
  launcherPath,
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
