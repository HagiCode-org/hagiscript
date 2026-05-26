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
const extensionsPath = path.join(context.runtimeDataHome, "extensions")
const wrapperPath = path.join(
  currentRoot,
  "bin",
  process.platform === "win32" ? "code-server.cmd" : "code-server"
)
const installMode = context.bundledInstallMode
const templateRoot =
  installMode === "archive-7z-only"
    ? context.templateDir
    : path.join(currentRoot, "templates")

await ensureDirectory(currentRoot)
const installedPackage = await installVendoredPackage(context, {
  prefixRoot: currentRoot,
  packageName: "code-server",
  entrypointRelativePath: path.join("out", "node", "entry.js"),
  installMode,
  archivePath: path.join(context.componentRoot, "archives", "code-server.7z")
})

if (installMode === "archive-7z-only") {
  await rm(currentRoot, { recursive: true, force: true })
  await materializeTemplate(
    "code-server-config.yaml",
    configPath,
    {
      BIND_ADDR: quoteYamlString("127.0.0.1:8080"),
      DATA_DIR: quoteYamlString(context.runtimeDataHome),
      EXTENSIONS_DIR: quoteYamlString(extensionsPath)
    },
    templateRoot
  )
  await rm(path.join(context.binDir, process.platform === "win32" ? "code-server.cmd" : "code-server"), {
    force: true
  })
} else {
  await materializeTemplate(
    "code-server-config.yaml",
    configPath,
    {
      BIND_ADDR: quoteYamlString("127.0.0.1:8080"),
      DATA_DIR: quoteYamlString(context.runtimeDataHome),
      EXTENSIONS_DIR: quoteYamlString(extensionsPath)
    },
    templateRoot
  )
  await writeCommandWrapper(context.binDir, "code-server", wrapperPath, {
    baseArgs: ["--config", configPath]
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
    ? `Downloaded code-server 7z archive to ${installedPackage.archivePath}\n`
    : `Prepared code-server assets in ${currentRoot}\n`
)
