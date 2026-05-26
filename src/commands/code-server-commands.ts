import { Command } from "commander"
import { registerDedicatedComponentCommand } from "./omniroute-commands.js"

export function registerCodeServerCommands(program: Command): void {
  registerDedicatedComponentCommand(
    program,
    "code_server",
    "manage the dedicated code-server runtime"
  )
}
