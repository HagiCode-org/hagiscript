import { describe, expect, it } from "vitest"
import { createCli } from "../cli.js"

describe("code-server CLI command", () => {
  it("exposes the retained dedicated code_server lifecycle group", () => {
    const command = createCli().commands.find((entry) => entry.name() === "code_server")

    expect(command).toBeDefined()
    expect(command?.helpInformation()).toContain("start")
    expect(command?.helpInformation()).toContain("status")
    expect(command?.helpInformation()).toContain("logs")
  })
})
