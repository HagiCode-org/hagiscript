import { homedir } from "node:os"
import { join, posix, relative, resolve, win32 } from "node:path"
import type { LoadedRuntimeManifest } from "./runtime-manifest.js"

export const defaultRuntimeRoot = "~/.hagicode/runtime"

export interface ResolvedRuntimePaths {
  root: string
  runtimeHome: string
  runtimeDataRoot: string
  bin: string
  config: string
  logs: string
  data: string
  stateFile: string
  componentsRoot: string
  componentDataRoot: string
  defaultPm2Home: string
  npmPrefix: string
  nodeRuntime: string
  dotnetRuntime: string
  vendoredRoot: string
}

export interface ResolveRuntimePathsOptions {
  runtimeRoot?: string
}

export function resolveRuntimePaths(
  manifest: LoadedRuntimeManifest,
  options: ResolveRuntimePathsOptions = {}
): ResolvedRuntimePaths {
  const root = normalizeManagedRoot(
    options.runtimeRoot ?? manifest.paths.runtimeRoot ?? defaultRuntimeRoot
  )
  const runtimeHome = resolveManagedPath(manifest.paths.runtimeHome, root)
  const runtimeDataRoot = resolveManagedPath(manifest.paths.runtimeDataRoot, root)

  return {
    root,
    runtimeHome,
    runtimeDataRoot,
    bin: resolveManagedPath(manifest.paths.bin, runtimeHome),
    config: resolveManagedPath(manifest.paths.config, runtimeDataRoot),
    logs: resolveManagedPath(manifest.paths.logs, runtimeDataRoot),
    data: resolveManagedPath(manifest.paths.data, runtimeDataRoot),
    stateFile: resolveManagedPath(manifest.paths.stateFile, runtimeDataRoot),
    componentsRoot: resolveManagedPath(manifest.paths.componentsRoot, runtimeHome),
    componentDataRoot: resolveManagedPath(manifest.paths.componentDataRoot, runtimeDataRoot),
    defaultPm2Home: manifest.paths.defaultPm2Home,
    npmPrefix: resolveManagedPath(manifest.paths.npmPrefix, runtimeHome),
    nodeRuntime: resolveManagedPath(manifest.paths.nodeRuntime, runtimeHome),
    dotnetRuntime: resolveManagedPath(manifest.paths.dotnetRuntime, runtimeHome),
    vendoredRoot: resolveManagedPath(manifest.paths.vendoredRoot, runtimeHome)
  }
}

export function normalizeManagedRoot(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error("Managed runtime root must be a non-empty path.")
  }

  return resolve(expandHomeDirectory(trimmed))
}

export function resolveManagedPath(pathValue: string, runtimeRoot: string): string {
  const expanded = expandHomeDirectory(pathValue.trim())
  const absolutePath = resolvePortableAbsolutePath(expanded)
  return absolutePath ?? resolve(runtimeRoot, expanded)
}

export function resolveReleasedServicePath(pathValue: string, componentRoot: string): string {
  return resolveManagedPath(pathValue, componentRoot)
}

export function getComponentManagedRoot(
  paths: ResolvedRuntimePaths,
  componentName: string
): string {
  switch (componentName) {
    case "node":
      return paths.nodeRuntime
    case "dotnet":
      return paths.dotnetRuntime
    case "npm-packages":
      return paths.npmPrefix
    case "omniroute":
    case "code-server":
      return join(paths.vendoredRoot, componentName)
    default:
      return join(paths.componentsRoot, componentName)
  }
}

export function getComponentConfigDirectory(
  paths: ResolvedRuntimePaths,
  componentName: string,
  runtimeDataDir?: string
): string {
  return join(getComponentRuntimeDataHome(paths, componentName, runtimeDataDir), "config")
}

export function getComponentLogsDirectory(
  paths: ResolvedRuntimePaths,
  componentName: string,
  runtimeDataDir?: string
): string {
  return join(getComponentRuntimeDataHome(paths, componentName, runtimeDataDir), "logs")
}

export function getComponentRuntimeDataHome(
  paths: ResolvedRuntimePaths,
  componentName: string,
  runtimeDataDir?: string
): string {
  return resolveManagedPath(runtimeDataDir ?? componentName, paths.componentDataRoot)
}

export function getComponentPm2Home(
  paths: ResolvedRuntimePaths,
  componentName: string,
  runtimeDataDir?: string,
  pm2Home?: string
): string {
  return resolveManagedPath(
    pm2Home ?? paths.defaultPm2Home,
    getComponentRuntimeDataHome(paths, componentName, runtimeDataDir)
  )
}

export function isPathInsideRuntimeRoot(
  runtimeRoot: string,
  targetPath: string
): boolean {
  const relativePath = relative(resolve(runtimeRoot), resolve(targetPath))
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("../"))
}

function expandHomeDirectory(value: string): string {
  if (value === "~") {
    return homedir()
  }

  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2))
  }

  return value
}

function resolvePortableAbsolutePath(value: string): string | undefined {
  if (posix.isAbsolute(value)) {
    return posix.normalize(value)
  }

  if (win32.isAbsolute(value)) {
    return win32.normalize(value)
  }

  return undefined
}
