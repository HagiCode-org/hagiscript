import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

export function readRuntimeScriptContext() {
  return {
    runtimeRoot: requiredEnv("HAGISCRIPT_RUNTIME_ROOT"),
    binDir: requiredEnv("HAGISCRIPT_RUNTIME_BIN_DIR"),
    configDir: requiredEnv("HAGISCRIPT_RUNTIME_CONFIG_DIR"),
    logsDir: requiredEnv("HAGISCRIPT_RUNTIME_LOGS_DIR"),
    dataDir: requiredEnv("HAGISCRIPT_RUNTIME_DATA_DIR"),
    statePath: requiredEnv("HAGISCRIPT_RUNTIME_STATE_PATH"),
    componentName: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_NAME"),
    componentType: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_TYPE"),
    componentRoot: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_ROOT"),
    componentConfigDir: requiredEnv("HAGISCRIPT_RUNTIME_COMPONENT_CONFIG_DIR"),
    templateDir: requiredEnv("HAGISCRIPT_RUNTIME_TEMPLATE_DIR"),
    componentVersion: process.env.HAGISCRIPT_RUNTIME_COMPONENT_VERSION?.trim() || null,
    phase: process.env.HAGISCRIPT_RUNTIME_PHASE?.trim() || "install",
    purge: process.env.HAGISCRIPT_RUNTIME_PURGE === "1"
  }
}

export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true })
}

export async function writeJsonFile(filePath, value) {
  await ensureDirectory(path.dirname(filePath))
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function writeComponentMarker(context, extra = {}) {
  const markerPath = path.join(context.componentRoot, ".hagicode-runtime.json")
  await writeJsonFile(markerPath, {
    component: context.componentName,
    type: context.componentType,
    version: context.componentVersion,
    phase: context.phase,
    runtimeRoot: context.runtimeRoot,
    generatedAt: new Date().toISOString(),
    ...extra
  })
  return markerPath
}

export async function materializeTemplate(templateName, destinationPath, variables) {
  const templatePath = path.join(readRuntimeScriptContext().templateDir, templateName)
  const template = await readFile(templatePath, "utf8")
  let rendered = template

  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value))
  }

  await ensureDirectory(path.dirname(destinationPath))
  await writeFile(destinationPath, rendered, "utf8")
  return destinationPath
}

export async function writeNodeEntrypoint(filePath, message) {
  await ensureDirectory(path.dirname(filePath))
  await writeFile(
    filePath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(message)} + "\\n")\n`,
    "utf8"
  )
  return filePath
}

export async function writeCommandWrapper(binDir, commandName, scriptPath) {
  await ensureDirectory(binDir)

  if (process.platform === "win32") {
    const wrapperPath = path.join(binDir, `${commandName}.cmd`)
    const relativeTarget = path.relative(path.dirname(wrapperPath), scriptPath).replaceAll("/", "\\")
    await writeFile(
      wrapperPath,
      `@echo off\r\nnode "%~dp0\\${relativeTarget}" %*\r\n`,
      "utf8"
    )
    return wrapperPath
  }

  const wrapperPath = path.join(binDir, commandName)
  const relativeTarget = path.relative(path.dirname(wrapperPath), scriptPath).replaceAll("\\", "/")
  await writeFile(
    wrapperPath,
    `#!/usr/bin/env sh\nexec node "$(dirname "$0")/${relativeTarget}" "$@"\n`,
    "utf8"
  )
  return wrapperPath
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Missing runtime script environment variable: ${name}`)
  }

  return value
}
