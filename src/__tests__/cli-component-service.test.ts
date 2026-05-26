import { beforeEach, describe, expect, it, vi } from "vitest"

const componentServiceManagerMocks = vi.hoisted(() => ({
  executeComponentServiceAction: vi.fn(
    async (
      component: "omniroute" | "code_server",
      action: string,
      options: { manifestPath?: string; runtimeRoot?: string; lines?: number }
    ) => ({
      component,
      service: component === "code_server" ? "code-server" : "omniroute",
      action,
      ok: true,
      options
    })
  ),
  renderComponentServiceResultText: vi.fn(() => "component service output"),
  MAX_COMPONENT_LOG_LINES: 2000,
  parseDedicatedComponentLinesOption: vi.fn((value: string) => {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2000) {
      throw new Error("--lines must be a positive integer between 1 and 2000.")
    }
    return parsed
  }),
  resolveComponentServiceDefinition: vi.fn()
}))

vi.mock("../runtime/component-service-manager.js", () => componentServiceManagerMocks)

import { createCli, runCli } from "../cli.js"

describe("dedicated component CLI commands", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("includes the omniroute and code_server command groups in help output", () => {
    const cli = createCli()
    const output = cli.helpInformation()
    const omnirouteHelp = cli.commands.find((command) => command.name() === "omniroute")?.helpInformation()
    const codeServerHelp = cli.commands.find((command) => command.name() === "code_server")?.helpInformation()

    expect(output).toContain("omniroute")
    expect(output).toContain("code_server")

    for (const helpText of [omnirouteHelp, codeServerHelp]) {
      expect(helpText).toContain("exact")
      expect(helpText).toContain("start")
      expect(helpText).toContain("stop")
      expect(helpText).toContain("restart")
      expect(helpText).toContain("status")
      expect(helpText).toContain("env")
      expect(helpText).toContain("logs")
    }
  })

  it("passes runtime context options into dedicated status actions", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "code_server",
      "status",
      "--runtime-root",
      "/tmp/runtime-root",
      "--from-manifest",
      "/tmp/manifest.yaml"
    ])

    expect(componentServiceManagerMocks.executeComponentServiceAction).toHaveBeenCalledWith(
      "code_server",
      "status",
      {
        manifestPath: "/tmp/manifest.yaml",
        runtimeRoot: "/tmp/runtime-root",
        lines: undefined
      }
    )
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "component service output"
    )

    stdout.mockRestore()
  })

  it("emits JSON output for dedicated actions", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "omniroute",
      "logs",
      "--runtime-root",
      "/tmp/runtime-root",
      "--lines",
      "25",
      "--json"
    ])

    const output = stdout.mock.calls.map(([value]) => String(value)).join("")
    expect(output).toContain('"component": "omniroute"')
    expect(output).toContain('"action": "logs"')
    expect(output).toContain('"lines": 25')

    stdout.mockRestore()
  })

  it("rejects invalid dedicated path options before runtime actions run", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await expect(
      runCli(["node", "hagiscript", "omniroute", "status", "--runtime-root", " "])
    ).rejects.toThrow('process.exit unexpectedly called with "1"')

    expect(componentServiceManagerMocks.executeComponentServiceAction).not.toHaveBeenCalled()
    expect(stderr.mock.calls.map(([value]) => String(value)).join(""))
      .toContain("--runtime-root must be a non-empty path.")
    stderr.mockRestore()
  })

  it("rejects invalid dedicated line counts before log reads run", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await expect(
      runCli(["node", "hagiscript", "code_server", "logs", "--lines", "0"])
    ).rejects.toThrow('process.exit unexpectedly called with "1"')

    expect(componentServiceManagerMocks.executeComponentServiceAction).not.toHaveBeenCalled()
    expect(stderr.mock.calls.map(([value]) => String(value)).join(""))
      .toContain("--lines must be a positive integer between 1 and 2000.")
    stderr.mockRestore()
  })

  it("rejects unsupported dedicated actions before runtime work begins", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await expect(
      runCli(["node", "hagiscript", "omniroute", "unknown-action"])
    ).rejects.toThrow('process.exit unexpectedly called with "1"')

    expect(componentServiceManagerMocks.executeComponentServiceAction).not.toHaveBeenCalled()
    expect(stderr.mock.calls.map(([value]) => String(value)).join(""))
      .toContain('Unsupported omniroute action "unknown-action". Supported actions: exact, start, stop, restart, status, env, logs.')

    stderr.mockRestore()
  })
})
