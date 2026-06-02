import { homedir } from "node:os"
import { join, posix, relative, resolve, win32 } from "node:path"
import type { LoadedRuntimeManifest } from "./runtime-manifest.js"

export const defaultRuntimeRoot = "~/.hagicode/runtime"

export interface ResolvedRuntimePaths {
  root: string
  runtimeHome: string
  runtimeDataRoot: string
  serverProgramRoot: string
  serverDataRoot: string
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
  runtimeHome?: string
  runtimeDataRoot?: string
  serverProgramRoot?: string
  serverDataRoot?: string
}

export function resolveRuntimePaths(
  manifest: LoadedRuntimeManifest,
  options: ResolveRuntimePathsOptions = {}
): ResolvedRuntimePaths {
  const root = normalizeManagedRoot(
    options.runtimeRoot ?? manifest.paths.runtimeRoot ?? defaultRuntimeRoot
  )
  const runtimeHome = options.runtimeHome
    ? resolveManagedPath(options.runtimeHome, root)
    : resolveManagedPath(manifest.paths.runtimeHome, root)
  const runtimeDataRoot = options.runtimeDataRoot
    ? resolveManagedPath(options.runtimeDataRoot, root)
    : resolveManagedPath(manifest.paths.runtimeDataRoot, root)
  const serverProgramRoot = options.serverProgramRoot
    ? resolveManagedPath(options.serverProgramRoot, root)
    : manifest.paths.serverProgramRoot
      ? resolveManagedPath(manifest.paths.serverProgramRoot, root)
      : join(runtimeHome, "server")
  const serverDataRoot = options.serverDataRoot
    ? resolveManagedPath(options.serverDataRoot, root)
    : manifest.paths.serverDataRoot
      ? resolveManagedPath(manifest.paths.serverDataRoot, root)
      : join(runtimeDataRoot, "server")

  return {
    root,
    runtimeHome,
    runtimeDataRoot,
    serverProgramRoot,
    serverDataRoot,
    bin: resolveManagedPath(manifest.paths.bin, runtimeHome),
    config: resolveManagedPath(manifest.paths.config, runtimeDataRoot),
    logs: resolveManagedPath(manifest.paths.logs, runtimeDataRoot),
    data: resolveManagedPath(manifest.paths.data, runtimeDataRoot),
    stateFile: resolveManagedPath(manifest.paths.stateFile, runtimeDataRoot),
    componentsRoot: resolveManagedPath(manifest.paths.componentsRoot, runtimeHome),
    componentDataRoot: resolveManagedPath(manifest.paths.componentDataRoot, runtimeDataRoot),
    defaultPm2Home: manifest.paths.defaultPm2Home,
    npmPrefix: resolveManagedPath(manifest.paths.npmPrefix, runtimeDataRoot),
    nodeRuntime: resolveManagedPath(manifest.paths.nodeRuntime, runtimeHome),
    dotnetRuntime: resolveManagedPath(manifest.paths.dotnetRuntime, runtimeHome),
    vendoredRoot: resolveManagedPath(manifest.paths.vendoredRoot ?? "components/bundled", runtimeHome)
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
    case "omniroute":
    case "code-server":
      return join(paths.vendoredRoot, componentName)
    case "server":
      return paths.serverProgramRoot
    default:
      return join(paths.componentsRoot, componentName)
  }
}

export function getRuntimeComponentsRoot(paths: ResolvedRuntimePaths): string {
  return join(paths.runtimeDataRoot, "runtimeComponents")
}

export function sanitizeRuntimeComponentVersionSegment(version: string): string {
  const normalized = version.trim().replaceAll(/[^A-Za-z0-9._-]+/g, "-")
  const sanitized = normalized.replaceAll(/^[.-]+|[.-]+$/g, "")

  if (!sanitized) {
    throw new Error(`Managed runtime component version is invalid: ${JSON.stringify(version)}`)
  }

  return sanitized
}

export function getVersionedRuntimeComponentRoot(
  paths: ResolvedRuntimePaths,
  componentDirectoryName: string,
  version: string
): string {
  return join(
    getRuntimeComponentsRoot(paths),
    componentDirectoryName,
    sanitizeRuntimeComponentVersionSegment(version)
  )
}

export function getServerProgramRoot(paths: ResolvedRuntimePaths): string {
  return paths.serverProgramRoot
}

export function getServerVersionsRoot(paths: ResolvedRuntimePaths): string {
  return join(getServerProgramRoot(paths), "versions")
}

export function getServerVersionRoot(
  paths: ResolvedRuntimePaths,
  version: string
): string {
  return join(getServerVersionsRoot(paths), version)
}

export function getServerSharedDataRoot(paths: ResolvedRuntimePaths): string {
  return paths.serverDataRoot
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
  if (componentName === "server") {
    return paths.serverDataRoot
  }

  return resolveManagedPath(runtimeDataDir ?? componentName, paths.componentDataRoot)
}

export function getComponentPm2Home(
  paths: ResolvedRuntimePaths,
  componentName: string,
  runtimeDataDir?: string,
  pm2Home?: string,
  defaultHomeName?: string
): string {
  if (pm2Home) {
    return resolveManagedPath(
      pm2Home,
      getComponentRuntimeDataHome(paths, componentName, runtimeDataDir)
    )
  }

  return resolveManagedPath(`~/.hagiscript/pm2/${defaultHomeName ?? componentName}`, paths.root)
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
