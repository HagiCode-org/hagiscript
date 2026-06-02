import { Command } from "commander"
import {
  executeComponentServiceAction,
  renderComponentServiceResultText,
  type DedicatedComponentAction,
  type DedicatedComponentName
} from "../runtime/component-service-manager.js"
import {
  applyDedicatedComponentCommonOptions,
  applyDedicatedComponentLogOptions,
  type DedicatedComponentCommandOptions,
  validateDedicatedPathOption
} from "./component-command-options.js"

const supportedActions: readonly DedicatedComponentAction[] = [
  "exact",
  "start",
  "stop",
  "restart",
  "status",
  "env",
  "logs"
]

export function registerOmniRouteCommands(program: Command): void {
  registerDedicatedComponentCommand(program, "omniroute", "manage the dedicated OmniRoute runtime")
}

export function registerDedicatedComponentCommand(
  program: Command,
  component: DedicatedComponentName,
  description: string
): void {
  const group = program.command(component).description(description)

  for (const action of supportedActions) {
    const command = group.command(action).description(describeAction(component, action))
    ;(action === "logs" ? applyDedicatedComponentLogOptions : applyDedicatedComponentCommonOptions)(command)
    command.action(async (options: DedicatedComponentCommandOptions, subcommand: Command) => {
      try {
        const result = await executeComponentServiceAction(component, action, {
          manifestPath: validateDedicatedPathOption(options.fromManifest, "--from-manifest"),
          runtimeRoot: validateDedicatedPathOption(options.runtimeRoot, "--runtime-root"),
          lines: options.lines
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${renderComponentServiceResultText(result)}\n`
        )
      } catch (error) {
        subcommand.error(error instanceof Error ? error.message : String(error), { exitCode: 1 })
      }
    })
  }

  group.on("command:*", (operands: string[]) => {
    group.error(
      `Unsupported ${component} action "${operands[0] ?? ""}". Supported actions: ${supportedActions.join(", ")}.`,
      { exitCode: 1 }
    )
  })
}

function describeAction(
  component: DedicatedComponentName,
  action: DedicatedComponentAction
): string {
  switch (action) {
    case "exact":
      return `extract the packaged ${component} .7z runtime into the managed extracted-runtime directory`
    case "logs":
      return `read recent ${component} log output from the managed runtime-data boundary`
    case "env":
      return `show the managed ${component} launch environment without starting the service`
    default:
      return `${action} the managed ${component} service`
  }
}
