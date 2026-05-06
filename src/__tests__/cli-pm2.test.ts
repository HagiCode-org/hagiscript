import { describe, expect, it, vi } from "vitest"

const pm2ManagerMocks = vi.hoisted(() => ({
  runManagedPm2Command: vi.fn(async () => ({
    service: "omniroute",
    action: "status",
    appName: "fixture-omniroute",
    cwd: "/tmp/runtime/program/components/services/omniroute/current",
    script: "/tmp/runtime/program/components/services/omniroute/current/omniroute-launcher.mjs",
    runtimeHome: "/tmp/runtime/program",
    runtimeDataHome: "/tmp/runtime/runtime-data/components/services/omniroute",
    pm2Home: "/tmp/runtime/runtime-data/components/services/omniroute/pm2",
    pm2Binary: "/tmp/runtime/program/npm/bin/pm2",
    exists: true,
    status: "online",
    pid: 4242,
    stdout: "[]",
    stderr: ""
  })),
  renderManagedPm2StatusText: vi.fn(() => "pm2 status output"),
  supportedPm2Services: ["omniroute", "code-server"]
}))

vi.mock("../runtime/pm2-manager.js", () => pm2ManagerMocks)

import { createCli, runCli } from "../cli.js"

describe("pm2 CLI commands", () => {
  it("includes the pm2 command group in help output", () => {
    const cli = createCli()
    const output = cli.helpInformation()

    expect(output).toContain("pm2")
  })

  it("passes service, action, and runtime options to the PM2 manager", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "pm2",
      "omniroute",
      "status",
      "--runtime-root",
      "/tmp/runtime-root"
    ])

    expect(pm2ManagerMocks.runManagedPm2Command).toHaveBeenCalledWith({
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root",
      service: "omniroute",
      action: "status"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "pm2 status output"
    )

    stdout.mockRestore()
  })
})
