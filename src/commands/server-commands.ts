import { Command, InvalidArgumentError } from "commander"
import {
  getManagedServerStatus,
  installManagedServer,
  listManagedServerVersions,
  removeManagedServerInstalledVersion,
  resolveManagedServerStartupEnvironment,
  restartManagedServer,
  startManagedServer,
  stopManagedServer,
  useManagedServerVersion,
  type ManagedServerInstallResult,
  type ManagedServerListResult,
  type ManagedServerRemoveVersionResult,
  type ManagedServerUseVersionResult
} from "../runtime/server-manager.js"
import {
  getManagedServerConfig,
  setManagedServerConfig,
  type ManagedServerConfigResult
} from "../runtime/server-config.js"
import {
  renderManagedPm2EnvironmentText,
  renderManagedPm2StatusText,
  type ManagedPm2CommandResult
} from "../runtime/pm2-manager.js"

interface ServerBaseOptions {
  fromManifest?: string
  runtimeRoot?: string
  instance?: string
  json?: boolean
}

interface ServerVersionCommandOptions {
  fromManifest?: string
  runtimeRoot?: string
  json?: boolean
}

interface ServerConfigGetOptions {
  fromManifest?: string
  runtimeRoot?: string
  json?: boolean
}

interface ServerConfigSetOptions extends ServerConfigGetOptions {
  host?: string
  port?: number
}

interface ServerInstallOptions extends ServerBaseOptions {
  archive?: string
  packageDir?: string
  url?: string
  indexUrl?: string
  indexChannel?: string
  indexVersion?: string
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

  const serverConfig = server
    .command("config")
    .description("query and update persisted managed server configuration")

  serverConfig
    .command("get")
    .description("show effective managed server config")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--json", "emit machine-readable JSON output")
    .action(async (options: ServerConfigGetOptions, command: Command) => {
      try {
        const result = await getManagedServerConfig({
          manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
          runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root")
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderManagedServerConfigText(result)}\n`
        )
      } catch (error) {
        command.error(formatServerError(error), { exitCode: 1 })
      }
    })

  serverConfig
    .command("set")
    .description("update managed server host and/or port")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--host <host>", "override ASP.NET Core listen host")
    .option("--port <number>", "override ASP.NET Core listen port", parsePortOption)
    .option("--json", "emit machine-readable JSON output")
    .action(async (options: ServerConfigSetOptions, command: Command) => {
      try {
        const result = await setManagedServerConfig(
          {
            host: options.host?.trim(),
            port: options.port
          },
          {
            manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
            runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root")
          }
        )

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderManagedServerConfigText(result)}\n`
        )
      } catch (error) {
        command.error(formatServerError(error), { exitCode: 1 })
      }
    })

  server
    .command("install")
    .description("download or stage a server package and install runtime dependencies, including managed pm2")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--archive <path>", "install from a local server zip archive")
    .option("--package-dir <path>", "install the newest matching server archive from a local directory")
    .option("--url <url>", "download the server archive from a direct URL")
    .option(
      "--index-url <url>",
      "resolve the server archive from an HTTP index document"
    )
    .option(
      "--index-channel <name>",
      "prefer versions listed under the given index channel"
    )
    .option(
      "--index-version <version>",
      "use an explicit version from the HTTP index"
    )
    .option(
      "--github-repo <owner/repo>",
      "GitHub repository containing released server archives",
      "HagiCode-org/releases"
    )
    .option("--tag <tag>", "GitHub release tag to download", "latest")
    .option("--asset <name>", "exact archive asset name to install")
    .option("--force", "reinstall runtime dependencies and the server runtime component")
    .option("--no-ensure-pm2", "skip installation of the managed pm2 npm dependency")
    .option("--pm2-version <range>", "override the managed pm2 npm version or semver range")
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
          indexUrl: validateUrlOption(options.indexUrl, "--index-url"),
          indexChannel: validateTagOption(options.indexChannel),
          indexVersion: validateTagOption(options.indexVersion),
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

  server
    .command("list")
    .description("list installed managed server versions and show the active version")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--json", "emit machine-readable JSON output")
    .action(async (options: ServerVersionCommandOptions, command: Command) => {
      try {
        const result = await listManagedServerVersions({
          manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
          runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root")
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderManagedServerVersionListText(result)}\n`
        )
      } catch (error) {
        command.error(formatServerError(error), { exitCode: 1 })
      }
    })

  server
    .command("use")
    .description("activate an installed managed server version")
    .argument("<version>", "installed managed server version to activate")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--json", "emit machine-readable JSON output")
    .action(async (version: string, options: ServerVersionCommandOptions, command: Command) => {
      try {
        const result = await useManagedServerVersion({
          version: validateVersionOption(version, "<version>")!,
          manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
          runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root")
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderManagedServerUseText(result)}\n`
        )
      } catch (error) {
        command.error(formatServerError(error), { exitCode: 1 })
      }
    })

  server
    .command("remove")
    .description("remove an installed managed server version")
    .argument("<version>", "installed managed server version to remove")
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--json", "emit machine-readable JSON output")
    .action(async (version: string, options: ServerVersionCommandOptions, command: Command) => {
      try {
        const result = await removeManagedServerInstalledVersion({
          version: validateVersionOption(version, "<version>")!,
          manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
          runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root")
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderManagedServerRemoveText(result)}\n`
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
        "override the manifest-defined PM2 instance identifier used to namespace the managed server app name"
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
    `Source version: ${result.source.version ?? "n/a"}`,
    `Installed version: ${result.installedVersion}`,
    `Active version: ${result.activeVersion}`,
    `Managed root: ${result.runtimeLifecycle.paths.root}`,
    `Shared data root: ${result.sharedDataRoot}`,
    `Staged payload: ${result.stagedPath}`,
    `DLL: ${result.stagedDllPath}`,
    `Changed runtime components: ${result.runtimeLifecycle.changedComponents.join(", ") || "(none)"}`,
    `PM2 ensured: ${result.pm2.ensured ? "yes" : "no"}`,
    `Runtime ready: ${result.runtimeState.ready ? "yes" : "no"}`,
    ...(result.runtimeLifecycle.logFilePath ? [`Log: ${result.runtimeLifecycle.logFilePath}`] : [])
  ].join("\n")
}

function renderManagedServerVersionListText(result: ManagedServerListResult): string {
  return [
    "Managed server versions.",
    `Active version: ${result.activeVersion ?? "(none)"}`,
    `Shared data root: ${result.sharedDataRoot}`,
    `State path: ${result.statePath}`,
    ...(result.versions.length === 0
      ? ["Installed versions: (none)"]
      : [
          "Installed versions:",
          ...result.versions.map(
            (entry) =>
              `  - ${entry.version}${entry.active ? " (active)" : ""} -> ${entry.installPath}`
          )
        ])
  ].join("\n")
}

function renderManagedServerUseText(result: ManagedServerUseVersionResult): string {
  return [
    "Managed server version activated.",
    `Previous active version: ${result.previousActiveVersion ?? "(none)"}`,
    `Active version: ${result.activeVersion}`,
    `State path: ${result.statePath}`
  ].join("\n")
}

function renderManagedServerRemoveText(result: ManagedServerRemoveVersionResult): string {
  return [
    "Managed server version removed.",
    `Removed version: ${result.removedVersion}`,
    `Removed path: ${result.removedPath}`,
    `Active version: ${result.activeVersion ?? "(none)"}`,
    `State path: ${result.statePath}`
  ].join("\n")
}

function renderManagedServerConfigText(result: ManagedServerConfigResult): string {
  return [
    "Managed server config.",
    `Host: ${result.host}`,
    `Port: ${result.port}`,
    `ASPNETCORE_URLS: ${result.aspNetCoreUrls}`,
    `Source: ${result.source}`,
    `Config path: ${result.configPath}`
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

function parsePortOption(value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/u.test(normalized)) {
    throw new InvalidArgumentError("--port must be an integer.")
  }

  const port = Number.parseInt(normalized, 10)
  if (port < 1 || port > 65535) {
    throw new InvalidArgumentError("--port must be between 1 and 65535.")
  }

  return port
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
