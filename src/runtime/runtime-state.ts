import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { LoadedRuntimeManifest } from "./runtime-manifest.js"
import type { ResolvedRuntimePaths } from "./runtime-paths.js"

export type RuntimeComponentStatus =
  | "not-installed"
  | "installed"
  | "removed"
  | "failed"

export interface RuntimeComponentState {
  name: string
  type: string
  status: RuntimeComponentStatus
  version: string | null
  managedProgramPaths: string[]
  managedDataPaths: string[]
  managedPaths: string[]
  lastAction: "install" | "remove" | "update" | null
  lastUpdatedAt: string | null
  logFile: string | null
  details?: Record<string, unknown>
}

export interface RuntimeOperationState {
  phase: "install" | "remove" | "update"
  status: "success" | "failed"
  selectedComponents: string[]
  completedComponents: string[]
  startedAt: string
  finishedAt: string
  logFile: string | null
  message?: string
}

export interface RuntimeState {
  schemaVersion: 1
  runtime: {
    name: string
    version: string
    manifestPath: string
  }
  managedRoot: string
  managedPaths: ResolvedRuntimePaths
  components: Record<string, RuntimeComponentState>
  lastOperation: RuntimeOperationState | null
}

export class RuntimeStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuntimeStateError"
  }
}

export function createInitialRuntimeState(
  manifest: LoadedRuntimeManifest,
  paths: ResolvedRuntimePaths
): RuntimeState {
  return {
    schemaVersion: 1,
    runtime: {
      name: manifest.runtime.name,
      version: manifest.runtime.version,
      manifestPath: manifest.manifestPath
    },
    managedRoot: paths.root,
    managedPaths: paths,
    components: {},
    lastOperation: null
  }
}

export async function readRuntimeState(statePath: string): Promise<RuntimeState | null> {
  let parsed: unknown

  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"))
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }

    const message = error instanceof Error ? error.message : String(error)
    throw new RuntimeStateError(`Failed to read runtime state ${statePath}: ${message}`)
  }

  return validateRuntimeState(parsed, statePath)
}

export async function writeRuntimeState(
  statePath: string,
  state: RuntimeState
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

export function mergeRuntimeState(
  manifest: LoadedRuntimeManifest,
  paths: ResolvedRuntimePaths,
  state: RuntimeState | null
): RuntimeState {
  const nextState = state ?? createInitialRuntimeState(manifest, paths)

  return {
    ...nextState,
    runtime: {
      name: manifest.runtime.name,
      version: manifest.runtime.version,
      manifestPath: manifest.manifestPath
    },
    managedRoot: paths.root,
    managedPaths: paths,
    components: { ...nextState.components }
  }
}

function validateRuntimeState(value: unknown, statePath: string): RuntimeState {
  if (!isRecord(value)) {
    throw new RuntimeStateError(`Runtime state ${statePath} must be a JSON object.`)
  }

  if (value.schemaVersion !== 1) {
    throw new RuntimeStateError(
      `Runtime state ${statePath} has unsupported schemaVersion ${String(value.schemaVersion)}.`
    )
  }

  if (!isRecord(value.runtime) || typeof value.runtime.name !== "string" || typeof value.runtime.version !== "string") {
    throw new RuntimeStateError(`Runtime state ${statePath} is missing runtime metadata.`)
  }

  if (!isRecord(value.managedPaths)) {
    throw new RuntimeStateError(`Runtime state ${statePath} is missing managedPaths.`)
  }

  if (!isRecord(value.components)) {
    throw new RuntimeStateError(`Runtime state ${statePath} is missing components.`)
  }

  return value as unknown as RuntimeState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  )
}
