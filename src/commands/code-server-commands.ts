import { Command } from "commander"
import { registerDedicatedComponentCommand } from "./dedicated-component-commands.js"

export function registerCodeServerCommands(program: Command): void {
  registerDedicatedComponentCommand(
    program,
    "code_server",
    "manage the dedicated code-server runtime"
  )
}
