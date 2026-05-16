import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  loadRuntimeManifest,
  type LoadedRuntimeManifest
} from "./runtime-manifest.js"
import {
  getServerSharedDataRoot,
  resolveRuntimePaths,
  type ResolvedRuntimePaths
} from "./runtime-paths.js"
import type { ManagedServerSourceKind } from "./server-manager.js"

const MANAGED_SERVER_STATE_FILE = "versions-state.json"

export interface ManagedServerInstalledVersion {
  version: string
  installPath: string
  installedAt: string
  source: {
    kind: ManagedServerSourceKind
    locator: string
    assetName: string
  }
}

export interface ManagedServerVersionState {
  schemaVersion: 1
  activeVersion: string | null
  versions: Record<string, ManagedServerInstalledVersion>
}

export interface ManagedServerVersionSummary extends ManagedServerInstalledVersion {
  active: boolean
}

export class ManagedServerVersionStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ManagedServerVersionStateError"
  }
}

export interface ManagedServerVersionStateContext {
  manifest: LoadedRuntimeManifest
  paths: ResolvedRuntimePaths
  statePath: string
}

export async function resolveManagedServerVersionStateContext(options: {
  manifestPath?: string
  runtimeRoot?: string
} = {}): Promise<ManagedServerVersionStateContext> {
  const manifest = await loadRuntimeManifest({ manifestPath: options.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: options.runtimeRoot })

  return {
    manifest,
    paths,
    statePath: getManagedServerVersionStatePath(paths)
  }
}

export function getManagedServerVersionStatePath(paths: ResolvedRuntimePaths): string {
  return join(getServerSharedDataRoot(paths), MANAGED_SERVER_STATE_FILE)
}

export function createInitialManagedServerVersionState(): ManagedServerVersionState {
  return {
    schemaVersion: 1,
    activeVersion: null,
    versions: {}
  }
}

export async function readManagedServerVersionState(
  statePath: string
): Promise<ManagedServerVersionState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown
    return validateManagedServerVersionState(parsed, statePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createInitialManagedServerVersionState()
    }

    if (error instanceof ManagedServerVersionStateError) {
      throw error
    }

    throw new ManagedServerVersionStateError(
      `Failed to read managed server version state: ${statePath}`,
      error instanceof Error ? { cause: error } : undefined
    )
  }
}

export async function writeManagedServerVersionState(
  statePath: string,
  state: ManagedServerVersionState
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

export async function registerManagedServerVersion(
  statePath: string,
  version: ManagedServerInstalledVersion,
  options: {
    activate?: boolean
  } = {}
): Promise<ManagedServerVersionState> {
  const state = await readManagedServerVersionState(statePath)
  const nextState: ManagedServerVersionState = {
    ...state,
    activeVersion: options.activate === false ? state.activeVersion : version.version,
    versions: {
      ...state.versions,
      [version.version]: version
    }
  }

  await writeManagedServerVersionState(statePath, nextState)
  return nextState
}

export async function setActiveManagedServerVersion(
  statePath: string,
  version: string
): Promise<ManagedServerVersionState> {
  const state = await readManagedServerVersionState(statePath)
  if (!state.versions[version]) {
    throw new ManagedServerVersionStateError(
      `Managed server version ${version} is not installed.`
    )
  }

  const nextState: ManagedServerVersionState = {
    ...state,
    activeVersion: version,
    versions: { ...state.versions }
  }

  await writeManagedServerVersionState(statePath, nextState)
  return nextState
}

export async function removeManagedServerVersion(
  statePath: string,
  version: string
): Promise<ManagedServerVersionState> {
  const state = await readManagedServerVersionState(statePath)
  if (!state.versions[version]) {
    throw new ManagedServerVersionStateError(
      `Managed server version ${version} is not installed.`
    )
  }

  if (state.activeVersion === version) {
    throw new ManagedServerVersionStateError(
      `Managed server version ${version} is currently active and cannot be removed.`
    )
  }

  const nextVersions = { ...state.versions }
  delete nextVersions[version]

  const nextState: ManagedServerVersionState = {
    ...state,
    versions: nextVersions
  }

  await writeManagedServerVersionState(statePath, nextState)
  return nextState
}

export async function listManagedServerVersions(
  statePath: string
): Promise<ManagedServerVersionSummary[]> {
  const state = await readManagedServerVersionState(statePath)

  return Object.values(state.versions)
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
    .map((entry) => ({
      ...entry,
      active: state.activeVersion === entry.version
    }))
}

function validateManagedServerVersionState(
  value: unknown,
  statePath: string
): ManagedServerVersionState {
  if (!isRecord(value)) {
    throw new ManagedServerVersionStateError(
      `Managed server version state must be a JSON object: ${statePath}`
    )
  }

  if (value.schemaVersion !== 1) {
    throw new ManagedServerVersionStateError(
      `Managed server version state ${statePath} has unsupported schemaVersion ${String(value.schemaVersion)}.`
    )
  }

  if (!(typeof value.activeVersion === "string" || value.activeVersion === null)) {
    throw new ManagedServerVersionStateError(
      `Managed server version state ${statePath} has invalid activeVersion.`
    )
  }

  if (!isRecord(value.versions)) {
    throw new ManagedServerVersionStateError(
      `Managed server version state ${statePath} is missing versions.`
    )
  }

  const versions: Record<string, ManagedServerInstalledVersion> = {}
  for (const [version, entry] of Object.entries(value.versions)) {
    if (!isRecord(entry)) {
      throw new ManagedServerVersionStateError(
        `Managed server version ${version} in ${statePath} must be a JSON object.`
      )
    }

    if (
      entry.version !== version ||
      typeof entry.installPath !== "string" ||
      typeof entry.installedAt !== "string" ||
      !isRecord(entry.source) ||
      !isManagedServerSourceKind(entry.source.kind) ||
      typeof entry.source.locator !== "string" ||
      typeof entry.source.assetName !== "string"
    ) {
      throw new ManagedServerVersionStateError(
        `Managed server version ${version} in ${statePath} is invalid.`
      )
    }

    versions[version] = {
      version,
      installPath: entry.installPath,
      installedAt: entry.installedAt,
      source: {
        kind: entry.source.kind,
        locator: entry.source.locator,
        assetName: entry.source.assetName
      }
    }
  }

  return {
    schemaVersion: 1,
    activeVersion: value.activeVersion,
    versions
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isManagedServerSourceKind(value: unknown): value is ManagedServerSourceKind {
  return (
    value === "github-release" ||
    value === "http-index" ||
    value === "direct-url" ||
    value === "local-archive" ||
    value === "local-folder"
  )
}
