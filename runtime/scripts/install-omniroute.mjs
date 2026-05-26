#!/usr/bin/env node
import path from "node:path"
import { rm } from "node:fs/promises"
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
const installMode = context.bundledInstallMode
const templateRoot =
  installMode === "archive-7z-only"
    ? context.templateDir
    : path.join(currentRoot, "templates")

await ensureDirectory(currentRoot)
const installedPackage = await installVendoredPackage(context, {
  prefixRoot: currentRoot,
  packageName: "omniroute",
  entrypointRelativePath: path.join("bin", "omniroute.mjs"),
  installMode,
  archivePath: path.join(context.componentRoot, "archives", "omniroute.7z")
})

if (installMode === "archive-7z-only") {
  await rm(currentRoot, { recursive: true, force: true })
  await materializeTemplate(
    "omniroute-config.yaml",
    configPath,
    {
      RUNTIME_ROOT: quoteYamlString(context.runtimeHome),
      LISTEN_ADDR: quoteYamlString("127.0.0.1:39001"),
      DATA_DIR: quoteYamlString(context.runtimeDataHome),
      LOGS_DIR: quoteYamlString(context.componentLogsDir)
    },
    templateRoot
  )
  await rm(path.join(context.binDir, process.platform === "win32" ? "omniroute.cmd" : "omniroute"), {
    force: true
  })
} else {
  await materializeTemplate(
    "omniroute-config.yaml",
    configPath,
    {
      RUNTIME_ROOT: quoteYamlString(context.runtimeHome),
      LISTEN_ADDR: quoteYamlString("127.0.0.1:39001"),
      DATA_DIR: quoteYamlString(context.runtimeDataHome),
      LOGS_DIR: quoteYamlString(context.componentLogsDir)
    },
    templateRoot
  )
  await writeCommandWrapper(context.binDir, "omniroute", wrapperPath, {
    baseArgs: ["--config", configPath, "--no-open"]
  })
}

await writeComponentMarker(context, {
  configPath,
  bundledInstallMode: installMode,
  wrapperPath: installMode === "archive-7z-only" ? null : wrapperPath,
  entrypointPath: installedPackage.entrypointPath ?? null,
  archivePath: installedPackage.archivePath ?? null,
  archiveFormat: installedPackage.archiveFormat,
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
process.stdout.write(
  installMode === "archive-7z-only"
    ? `Downloaded omniroute 7z archive to ${installedPackage.archivePath}\n`
    : `Prepared omniroute assets in ${currentRoot}\n`
)
