import { Command, InvalidArgumentError } from "commander"
import {
  getManagedServerStatus,
  installManagedServer,
  resolveManagedServerStartupEnvironment,
  restartManagedServer,
  startManagedServer,
  stopManagedServer,
  type ManagedServerInstallResult
} from "../runtime/server-manager.js"
import {
  renderManagedPm2EnvironmentText,
  renderManagedPm2StatusText,
  type ManagedPm2CommandResult,
  type ManagedPm2EnvironmentResult
} from "../runtime/pm2-manager.js"

interface ServerBaseOptions {
  fromManifest?: string
  runtimeRoot?: string
  instance?: string
  json?: boolean
}

interface ServerInstallOptions extends ServerBaseOptions {
  archive?: string
  packageDir?: string
  url?: string
  githubRepo?: string
  tag?: string
  asset?: string
  force?: boolean
  ensurePm2?: boolean
  pm2Version?: string
  registryMirror?: string
  downloadCache?: boolean
  downloadCacheDir?: string
  githubToken?: string
}

type ServerLifecycleAction = "start" | "restart" | "stop" | "status" | "env"

export function registerServerCommands(program: Command): void {
  const server = program
    .command("server")
    .description("install and operate the managed hagicode server")

  server
    .command("install")
    .description("download or stage a server package, install runtime dependencies, and prepare PM2")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--archive <path>", "install from a local server zip archive")
    .option("--package-dir <path>", "install the newest matching server archive from a local directory")
    .option("--url <url>", "download the server archive from a direct URL")
    .option(
      "--github-repo <owner/repo>",
      "GitHub repository containing released server archives",
      "HagiCode-org/releases"
    )
    .option("--tag <tag>", "GitHub release tag to download", "latest")
    .option("--asset <name>", "exact archive asset name to install")
    .option("--force", "force PM2 package sync and reinstall the server runtime component")
    .option("--no-ensure-pm2", "skip managed pm2 installation into the runtime npm prefix")
    .option("--pm2-version <range>", "pm2 version or semver range to ensure in the managed npm prefix")
    .option("--registry-mirror <url>", "npm registry mirror to use when installing managed pm2")
    .option("--no-download-cache", "disable reuse of the shared download cache")
    .option("--download-cache-dir <path>", "override the shared download cache directory")
    .option("--github-token <token>", "GitHub token used for release API and asset downloads")
    .option("--json", "emit machine-readable JSON output")
    .action(async (options: ServerInstallOptions, command: Command) => {
      try {
        const result = await installManagedServer({
          manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
          runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root"),
          archivePath: validatePathOption(options.archive, "--archive"),
          packageDirectory: validatePathOption(options.packageDir, "--package-dir"),
          url: validateUrlOption(options.url, "--url"),
          githubRepository: validateRepositoryOption(options.githubRepo),
          githubTag: validateTagOption(options.tag),
          assetName: validateAssetOption(options.asset),
          force: options.force ?? false,
          ensurePm2: options.ensurePm2 ?? true,
          pm2Version: validateVersionOption(options.pm2Version, "--pm2-version"),
          registryMirror: validateUrlOption(options.registryMirror, "--registry-mirror"),
          downloadCache: options.downloadCache,
          downloadCacheDir: validatePathOption(options.downloadCacheDir, "--download-cache-dir"),
          githubToken: validateTokenOption(options.githubToken),
          logger: (message) => process.stdout.write(`${message}\n`)
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderManagedServerInstallText(result)}\n`
        )
      } catch (error) {
        command.error(formatServerError(error), { exitCode: 1 })
      }
    })

  for (const action of ["start", "restart", "stop", "status", "env"] as const) {
    server
      .command(action)
      .description(serverLifecycleDescription(action))
      .option("--from-manifest <path>", "override the default runtime manifest")
      .option("--runtime-root <path>", "managed runtime root override")
      .option(
        "--instance <name>",
        "PM2 instance identifier used to namespace the managed server app name",
        "hagicode"
      )
      .option("--json", "emit machine-readable JSON output")
      .action(async (options: ServerBaseOptions, command: Command) => {
        try {
          if (action === "env") {
            const result = await resolveManagedServerStartupEnvironment({
              manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
              runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root"),
              instanceName: validateInstanceName(options.instance)
            })
            process.stdout.write(
              options.json
                ? `${JSON.stringify(result, null, 2)}\n`
                : `${renderManagedPm2EnvironmentText(result)}\n`
            )
            return
          }

          const result = await runServerLifecycleAction(action, {
            manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
            runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root"),
            instanceName: validateInstanceName(options.instance)
          })
          process.stdout.write(
            options.json
              ? `${JSON.stringify(result, null, 2)}\n`
              : `${renderManagedPm2StatusText(result)}\n`
          )
        } catch (error) {
          command.error(formatServerError(error), { exitCode: 1 })
        }
      })
  }
}

async function runServerLifecycleAction(
  action: Exclude<ServerLifecycleAction, "env">,
  options: {
    manifestPath?: string
    runtimeRoot?: string
    instanceName?: string
  }
): Promise<ManagedPm2CommandResult> {
  switch (action) {
    case "start":
      return startManagedServer(options)
    case "restart":
      return restartManagedServer(options)
    case "stop":
      return stopManagedServer(options)
    case "status":
      return getManagedServerStatus(options)
  }
}

function renderManagedServerInstallText(result: ManagedServerInstallResult): string {
  return [
    "Server install complete.",
    `Source: ${result.source.kind} (${result.source.locator})`,
    `Asset: ${result.source.assetName}`,
    `Version: ${result.source.version ?? "n/a"}`,
    `Managed root: ${result.runtimeLifecycle.paths.root}`,
    `Staged payload: ${result.stagedPath}`,
    `DLL: ${result.stagedDllPath}`,
    `Changed runtime components: ${result.runtimeLifecycle.changedComponents.join(", ") || "(none)"}`,
    `PM2 ensured: ${result.pm2.ensured ? "yes" : "no"}`,
    `Runtime ready: ${result.runtimeState.ready ? "yes" : "no"}`,
    ...(result.runtimeLifecycle.logFilePath ? [`Log: ${result.runtimeLifecycle.logFilePath}`] : [])
  ].join("\n")
}

function serverLifecycleDescription(action: ServerLifecycleAction): string {
  switch (action) {
    case "start":
      return "start the managed server through runtime-scoped PM2"
    case "restart":
      return "restart the managed server through runtime-scoped PM2"
    case "stop":
      return "stop the managed server through runtime-scoped PM2"
    case "status":
      return "inspect the managed server PM2 status"
    case "env":
      return "print the reusable managed startup environment for the server"
  }
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

function validateUrlOption(
  value: string | undefined,
  optionName: string
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError(`${optionName} must be a non-empty URL.`)
  }

  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new InvalidArgumentError(`${optionName} must use http or https.`)
    }
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw error
    }
    throw new InvalidArgumentError(`${optionName} must be a valid URL.`)
  }

  return normalized
}

function validateRepositoryOption(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized || !normalized.includes("/")) {
    throw new InvalidArgumentError("--github-repo must use the owner/repo format.")
  }

  return normalized
}

function validateTagOption(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError("--tag must be a non-empty release tag.")
  }

  return normalized
}

function validateAssetOption(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError("--asset must be a non-empty file name.")
  }

  return normalized
}

function validateVersionOption(
  value: string | undefined,
  optionName: string
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError(`${optionName} must be a non-empty version or range.`)
  }

  return normalized
}

function validateTokenOption(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError("--github-token must be non-empty when provided.")
  }

  return normalized
}

function validateInstanceName(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidArgumentError("--instance must be a non-empty identifier.")
  }

  return normalized
}

function formatServerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
