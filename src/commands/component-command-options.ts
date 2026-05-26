import { Command, InvalidArgumentError } from "commander"
import {
  MAX_COMPONENT_LOG_LINES,
  parseDedicatedComponentLinesOption
} from "../runtime/component-service-manager.js"

export interface DedicatedComponentCommandOptions {
  fromManifest?: string
  runtimeRoot?: string
  json?: boolean
  lines?: number
}

export function applyDedicatedComponentCommonOptions(command: Command): Command {
  return command
    .option("--from-manifest <path>", "override the default runtime manifest")
    .option("--runtime-root <path>", "managed runtime root override")
    .option("--json", "emit machine-readable JSON output")
}

export function applyDedicatedComponentLogOptions(command: Command): Command {
  return applyDedicatedComponentCommonOptions(command).option(
    "--lines <count>",
    `number of recent lines to return (1-${MAX_COMPONENT_LOG_LINES})`,
    parseLinesOption
  )
}

export function validateDedicatedPathOption(
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

function parseLinesOption(value: string): number {
  try {
    return parseDedicatedComponentLinesOption(value)
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error))
  }
}
