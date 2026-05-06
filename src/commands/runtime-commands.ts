import { Command, InvalidArgumentError } from "commander"
import {
  installRuntime,
  queryRuntimeState,
  removeRuntime,
  renderRuntimeStateText,
  updateRuntime,
  type RuntimeLifecycleOptions,
  type RuntimeLifecycleResult
} from "../runtime/runtime-manager.js"

interface RuntimeBaseOptions {
  fromManifest?: string
  runtimeRoot?: string
  components?: string[]
  verbose?: boolean
}

interface RuntimeInstallOptions extends RuntimeBaseOptions {
  dryRun?: boolean
  force?: boolean
}

interface RuntimeRemoveOptions extends RuntimeBaseOptions {
  dryRun?: boolean
  force?: boolean
  purge?: boolean
}

interface RuntimeUpdateOptions extends RuntimeBaseOptions {
  dryRun?: boolean
  force?: boolean
  checkOnly?: boolean
}

interface RuntimeStateOptions extends RuntimeBaseOptions {
  json?: boolean
}

export function registerRuntimeCommands(program: Command): void {
  const runtime = program
    .command("runtime")
    .description("manage manifest-driven hagicode-runtime components")

  runtime
    .command("install")
    .description("install runtime components into a managed runtime root")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option(
      "--components <list>",
      "comma-separated runtime component names to install",
      parseComponentList
    )
    .option("--dry-run", "print the install plan without mutating managed files")
    .option("--force", "force reinstall of mutable managed components")
    .option("--verbose", "print detailed lifecycle output")
    .action(async (options: RuntimeInstallOptions, command: Command) => {
      await runLifecycleCommand("install", options, command)
    })

  runtime
    .command("remove")
    .description("remove runtime components from the managed runtime root")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option(
      "--components <list>",
      "comma-separated runtime component names to remove",
      parseComponentList
    )
    .option("--dry-run", "print the removal plan without mutating managed files")
    .option("--force", "reserved compatibility flag for scripted removals")
    .option("--purge", "remove retained managed config and data where supported")
    .option("--verbose", "print detailed lifecycle output")
    .action(async (options: RuntimeRemoveOptions, command: Command) => {
      await runLifecycleCommand("remove", options, command)
    })

  runtime
    .command("update")
    .description("update installed runtime components")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option(
      "--components <list>",
      "comma-separated runtime component names to update",
      parseComponentList
    )
    .option("--dry-run", "print the update plan without mutating managed files")
    .option("--check-only", "report components that would be updated")
    .option("--force", "force update execution for mutable managed components")
    .option("--verbose", "print detailed lifecycle output")
    .action(async (options: RuntimeUpdateOptions, command: Command) => {
      await runLifecycleCommand("update", options, command)
    })

  runtime
    .command("state")
    .description("query the canonical managed runtime state")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--json", "emit machine-readable JSON output")
    .action(async (options: RuntimeStateOptions, command: Command) => {
      try {
        const report = await queryRuntimeState({
          manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
          runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root")
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify(report, null, 2)}\n`
            : `${renderRuntimeStateText(report)}\n`
        )
      } catch (error) {
        command.error(formatRuntimeError(error), { exitCode: 1 })
      }
    })
}

async function runLifecycleCommand(
  phase: "install" | "remove" | "update",
  options: RuntimeInstallOptions | RuntimeRemoveOptions | RuntimeUpdateOptions,
  command: Command
): Promise<void> {
  const runtimeOptions: RuntimeLifecycleOptions = {
    manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
    runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root"),
    components: options.components ?? [],
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    purge: "purge" in options ? options.purge ?? false : false,
    checkOnly: "checkOnly" in options ? options.checkOnly ?? false : false,
    verbose: options.verbose ?? false,
    logger: (message) => process.stdout.write(`${message}\n`)
  }

  try {
    const result =
      phase === "install"
        ? await installRuntime(runtimeOptions)
        : phase === "remove"
          ? await removeRuntime(runtimeOptions)
          : await updateRuntime(runtimeOptions)

    printLifecycleSummary(phase, runtimeOptions, result)
  } catch (error) {
    command.error(formatRuntimeError(error), { exitCode: 1 })
  }
}

function parseComponentList(value: string): string[] {
  const components = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  if (components.length === 0) {
    throw new InvalidArgumentError("--components must include at least one component name.")
  }

  return Array.from(new Set(components))
}

function validatePathOption(
  value: string | undefined,
  optionName: string
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError(`${optionName} must be a non-empty path.`)
  }

  if (normalized.includes("\0")) {
    throw new InvalidArgumentError(`${optionName} contains an invalid null byte.`)
  }

  return normalized
}

function printLifecycleSummary(
  phase: "install" | "remove" | "update",
  options: RuntimeLifecycleOptions,
  result: RuntimeLifecycleResult
): void {
  const modeSuffix =
    options.dryRun || (phase === "update" && options.checkOnly)
      ? options.checkOnly
        ? " (check-only)"
        : " (dry-run)"
      : ""

  process.stdout.write(`Runtime ${phase} complete${modeSuffix}.\n`)
  process.stdout.write(`Manifest: ${result.manifest.manifestPath}\n`)
  process.stdout.write(`Managed root: ${result.paths.root}\n`)
  process.stdout.write(`Planned components: ${result.plan.length}\n`)
  process.stdout.write(`Changed components: ${result.changedComponents.length}\n`)

  if (result.skipped.length > 0) {
    for (const skipped of result.skipped) {
      process.stdout.write(`Skipped: ${skipped.componentName} (${skipped.reason})\n`)
    }
  }

  if (result.logFilePath) {
    process.stdout.write(`Log: ${result.logFilePath}\n`)
  }
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
