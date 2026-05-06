import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { LoadedRuntimeManifest } from "./runtime-manifest.js"

export const defaultRuntimeRoot = "~/.hagicode/runtime"

export interface ResolvedRuntimePaths {
  root: string
  bin: string
  config: string
  logs: string
  data: string
  stateFile: string
  componentsRoot: string
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

  return {
    root,
    bin: resolveManagedPath(manifest.paths.bin, root),
    config: resolveManagedPath(manifest.paths.config, root),
    logs: resolveManagedPath(manifest.paths.logs, root),
    data: resolveManagedPath(manifest.paths.data, root),
    stateFile: resolveManagedPath(manifest.paths.stateFile, root),
    componentsRoot: resolveManagedPath(manifest.paths.componentsRoot, root),
    npmPrefix: resolveManagedPath(manifest.paths.npmPrefix, root),
    nodeRuntime: resolveManagedPath(manifest.paths.nodeRuntime, root),
    dotnetRuntime: resolveManagedPath(manifest.paths.dotnetRuntime, root),
    vendoredRoot: resolveManagedPath(manifest.paths.vendoredRoot, root)
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
  return isAbsolute(expanded) ? resolve(expanded) : resolve(runtimeRoot, expanded)
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
  componentName: string
): string {
  return join(paths.config, componentName)
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
