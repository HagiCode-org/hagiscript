import { describe, expect, it, vi } from "vitest"

const componentServiceMocks = vi.hoisted(() => ({
  executeComponentServiceAction: vi.fn(async () => ({
    component: "code_server",
    service: "code-server",
    action: "start",
    ok: true,
    status: {}
  })),
  renderComponentServiceResultText: vi.fn(() => "code_server output")
}))

vi.mock("../runtime/component-service-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/component-service-manager.js")>()),
  ...componentServiceMocks
}))

import { createCli, runCli } from "../cli.js"

describe("code-server CLI command", () => {
  it("exposes the retained dedicated code_server lifecycle group", () => {
    const command = createCli().commands.find((entry) => entry.name() === "code_server")

    expect(command).toBeDefined()
    expect(command?.helpInformation()).toContain("start")
    expect(command?.helpInformation()).toContain("status")
    expect(command?.helpInformation()).toContain("logs")
  })

  it("forwards --external-node-path to code_server actions", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "code_server",
      "start",
      "--runtime-root",
      "/tmp/runtime-root",
      "--external-node-path",
      "/opt/node/bin/node"
    ])

    expect(componentServiceMocks.executeComponentServiceAction).toHaveBeenLastCalledWith(
      "code_server",
      "start",
      expect.objectContaining({ externalNodePath: "/opt/node/bin/node" })
    )

    stdout.mockRestore()
  })

  it("forwards no external Node path when --external-node-path is omitted", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli(["node", "hagiscript", "code_server", "status", "--runtime-root", "/tmp/runtime-root"])

    expect(componentServiceMocks.executeComponentServiceAction.mock.lastCall?.[2]?.externalNodePath).toBeUndefined()

    stdout.mockRestore()
  })

  it.each([
    ["an empty value", ""],
    ["a null byte", "/opt/node\0/bin/node"]
  ])("rejects %s for --external-node-path before running a component action", async (_label, value) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const callsBefore = componentServiceMocks.executeComponentServiceAction.mock.calls.length

    await runCli(["node", "hagiscript", "code_server", "start", "--external-node-path", value])

    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("--external-node-path")
    expect(exit).toHaveBeenCalledWith(1)
    expect(componentServiceMocks.executeComponentServiceAction.mock.calls.length).toBe(callsBefore)

    exit.mockRestore()
    stderr.mockRestore()
  })
})
