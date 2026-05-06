import { Command, InvalidArgumentError } from "commander"
import {
  renderManagedPm2StatusText,
  runManagedPm2Command,
  supportedPm2Services,
  type ManagedPm2Action,
  type ManagedPm2ServiceName
} from "../runtime/pm2-manager.js"

interface Pm2CommandOptions {
  fromManifest?: string
  runtimeRoot?: string
}

export function registerPm2Commands(program: Command): void {
  program
    .command("pm2")
    .description("manage PM2-backed hagicode-runtime services")
    .argument("<service>", "managed service name", parseManagedPm2Service)
    .argument("<action>", "pm2 action", parseManagedPm2Action)
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .action(
      async (
        service: ManagedPm2ServiceName,
        action: ManagedPm2Action,
        options: Pm2CommandOptions,
        command: Command
      ) => {
        try {
          const result = await runManagedPm2Command({
            manifestPath: validatePathOption(options.fromManifest, "--from-manifest"),
            runtimeRoot: validatePathOption(options.runtimeRoot, "--runtime-root"),
            service,
            action
          })

          process.stdout.write(`${renderManagedPm2StatusText(result)}\n`)
        } catch (error) {
          command.error(formatPm2Error(error), { exitCode: 1 })
        }
      }
    )
}

function parseManagedPm2Service(value: string): ManagedPm2ServiceName {
  if ((supportedPm2Services as readonly string[]).includes(value)) {
    return value as ManagedPm2ServiceName
  }

  throw new InvalidArgumentError(
    `Unsupported managed PM2 service "${value}". Supported services: ${supportedPm2Services.join(", ")}.`
  )
}

function parseManagedPm2Action(value: string): ManagedPm2Action {
  if (value === "start" || value === "stop" || value === "status") {
    return value
  }

  throw new InvalidArgumentError(
    `Unsupported PM2 action "${value}". Supported actions: start, stop, status.`
  )
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

function formatPm2Error(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
