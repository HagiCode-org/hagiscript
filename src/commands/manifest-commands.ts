import { Command, InvalidArgumentError } from "commander"
import {
  initRuntimeManifest,
  readRuntimeManifestSummary,
  renderRuntimeManifestSummaryText,
  RuntimeManifestMutationError,
  updateRuntimeManifest,
  type RuntimeManifestNpmPackageUpdate,
  type RuntimeManifestPathUpdates
} from "../runtime/manifest-manager.js"

interface ManifestCommandOptions {
  runtimeRoot?: string
  runtimeHome?: string
  runtimeDataRoot?: string
  serverProgramRoot?: string
  serverDataRoot?: string
  npmPackageVersion?: string[]
  serverActiveVersion?: string
  force?: boolean
  json?: boolean
}

export function registerManifestCommands(program: Command): void {
  const manifest = program
    .command("manifest")
    .description("initialize and update managed runtime manifest files")

  manifest
    .command("get [path]")
    .alias("print")
    .description("show a friendly summary of a runtime manifest")
    .option("--json", "emit machine-readable JSON output")
    .action(async (path: string | undefined, options: ManifestCommandOptions, command: Command) => {
      try {
        const result = await readRuntimeManifestSummary(path)
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderRuntimeManifestSummaryText(result)}\n`
        )
      } catch (error) {
        command.error(formatManifestError(error), { exitCode: 1 })
      }
    })

  manifest
    .command("init [path]")
    .description("generate a new runtime manifest from Hagiscript's packaged default")
    .option("--runtime-root <path>", "set paths.runtimeRoot in the generated manifest")
    .option("--runtime-home <path>", "set paths.runtimeHome in the generated manifest")
    .option(
      "--runtime-data-root <path>",
      "set paths.runtimeDataRoot in the generated manifest"
    )
    .option(
      "--server-program-root <path>",
      "set paths.serverProgramRoot in the generated manifest"
    )
    .option(
      "--server-data-root <path>",
      "set paths.serverDataRoot in the generated manifest"
    )
    .option(
      "--npm-package-version <package=version>",
      "set npmSync.packages entries in the generated manifest",
      collectValues,
      []
    )
    .option(
      "--server-active-version <version>",
      "set the default server version preferred by server install"
    )
    .option("--force", "overwrite the output manifest if it already exists")
    .action(async (path: string | undefined, options: ManifestCommandOptions, command: Command) => {
      try {
        const result = await initRuntimeManifest({
          manifestPath: path ?? "hagiscript.manifest.yaml",
          pathUpdates: buildPathUpdates(options),
          npmPackageUpdates: buildNpmPackageUpdates(options),
          serverActiveVersion: validateOptionalString(
            options.serverActiveVersion,
            "--server-active-version"
          ),
          force: options.force ?? false
        })

        process.stdout.write(`${renderManifestMutationText("initialized", result)}\n`)
      } catch (error) {
        command.error(formatManifestError(error), { exitCode: 1 })
      }
    })

  manifest
    .command("set <path>")
    .description("update paths, npmSync package versions, or server defaults in a manifest")
    .option("--runtime-root <path>", "set paths.runtimeRoot")
    .option("--runtime-home <path>", "set paths.runtimeHome")
    .option("--runtime-data-root <path>", "set paths.runtimeDataRoot")
    .option("--server-program-root <path>", "set paths.serverProgramRoot")
    .option("--server-data-root <path>", "set paths.serverDataRoot")
    .option(
      "--npm-package-version <package=version>",
      "set npmSync.packages entries",
      collectValues,
      []
    )
    .option(
      "--server-active-version <version>",
      "set the default server version preferred by server install"
    )
    .action(async (path: string, options: ManifestCommandOptions, command: Command) => {
      try {
        const result = await updateRuntimeManifest({
          manifestPath: validateRequiredPath(path, "<path>"),
          pathUpdates: buildPathUpdates(options),
          npmPackageUpdates: buildNpmPackageUpdates(options),
          serverActiveVersion: validateOptionalString(
            options.serverActiveVersion,
            "--server-active-version"
          )
        })

        process.stdout.write(`${renderManifestMutationText("updated", result)}\n`)
      } catch (error) {
        command.error(formatManifestError(error), { exitCode: 1 })
      }
    })
}

function buildPathUpdates(options: ManifestCommandOptions): RuntimeManifestPathUpdates {
  return {
    runtimeRoot: validateOptionalString(options.runtimeRoot, "--runtime-root"),
    runtimeHome: validateOptionalString(options.runtimeHome, "--runtime-home"),
    runtimeDataRoot: validateOptionalString(
      options.runtimeDataRoot,
      "--runtime-data-root"
    ),
    serverProgramRoot: validateOptionalString(
      options.serverProgramRoot,
      "--server-program-root"
    ),
    serverDataRoot: validateOptionalString(options.serverDataRoot, "--server-data-root")
  }
}

function buildNpmPackageUpdates(
  options: ManifestCommandOptions
): RuntimeManifestNpmPackageUpdate[] {
  return (options.npmPackageVersion ?? []).map(parseNpmPackageVersionSpec)
}

function parseNpmPackageVersionSpec(value: string): RuntimeManifestNpmPackageUpdate {
  const trimmed = value.trim()
  const separatorIndex = trimmed.lastIndexOf("=")
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new InvalidArgumentError(
      "--npm-package-version must use the form <package=version>."
    )
  }

  const packageName = trimmed.slice(0, separatorIndex).trim()
  const version = trimmed.slice(separatorIndex + 1).trim()
  if (!packageName || !version) {
    throw new InvalidArgumentError(
      "--npm-package-version must use the form <package=version>."
    )
  }

  return {
    packageName,
    version,
    target: version
  }
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function validateRequiredPath(value: string, optionName: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError(`${optionName} must be a non-empty path.`)
  }

  return normalized
}

function validateOptionalString(
  value: string | undefined,
  optionName: string
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError(`${optionName} must be a non-empty string.`)
  }

  return normalized
}

function renderManifestMutationText(
  action: "initialized" | "updated",
  result: { manifestPath: string; changedFields: string[] }
): string {
  const lines = [
    `Manifest ${action}: ${result.manifestPath}`,
    `Changed fields: ${result.changedFields.length > 0 ? result.changedFields.join(", ") : "(default template)"}`
  ]

  return lines.join("\n")
}

function formatManifestError(error: unknown): string {
  if (error instanceof RuntimeManifestMutationError) {
    return error.message
  }

  return error instanceof Error ? error.message : String(error)
}