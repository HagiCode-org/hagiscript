import { describe, expect, it, vi } from "vitest"

const pm2ManagerMocks = vi.hoisted(() => ({
  runManagedPm2Command: vi.fn(async () => ({
    service: "server",
    action: "restart",
    appName: "fixture-server",
    cwd: "/tmp/runtime/program/components/server/current/lib",
    script: "/tmp/runtime/program/components/server/current/lib/PCode.Web.dll",
    runtimeHome: "/tmp/runtime/program",
    runtimeDataHome: "/tmp/runtime/runtime-data/components/services/server",
    pm2Home: "/tmp/runtime/runtime-data/components/services/server/.pm2",
    pm2Binary: "/tmp/runtime/program/npm/bin/pm2",
    launchStrategy: "released-service",
    dotnetPath: "/tmp/runtime/program/components/dotnet/current/dotnet",
    runtimeFilesDir: "/tmp/runtime/runtime-data/components/services/server/pm2-runtime",
    exists: true,
    status: "online",
    pid: 4242,
    stdout: "[]",
    stderr: ""
  })),
  resolveManagedPm2Environment: vi.fn(async () => ({
    service: "server",
    appName: "fixture-server",
    cwd: "/tmp/runtime/program/components/server/current/lib",
    script: "/tmp/runtime/program/components/server/current/lib/PCode.Web.dll",
    args: [],
    env: {
      HAGICODE_RUNTIME_HOME: "/tmp/runtime/program",
      ASPNETCORE_URLS: "http://127.0.0.1:39150",
      PATH: "/tmp/runtime/program/bin:/usr/bin"
    },
    pathKey: "PATH",
    pathEntries: ["/tmp/runtime/program/components/node/bin", "/tmp/runtime/program/npm/bin"],
    runtimeHome: "/tmp/runtime/program",
    runtimeDataHome: "/tmp/runtime/runtime-data/components/services/server",
    componentRoot: "/tmp/runtime/program/components/server",
    componentConfigDir: "/tmp/runtime/runtime-data/components/services/server/config",
    pm2Home: "/tmp/runtime/runtime-data/components/services/server/.pm2",
    pm2Binary: "/tmp/runtime/program/npm/bin/pm2",
    nodePath: "/tmp/runtime/program/components/node/bin/node",
    launchStrategy: "released-service",
    dotnetPath: "/tmp/runtime/program/components/dotnet/current/dotnet",
    runtimeFilesDir: "/tmp/runtime/runtime-data/components/services/server/pm2-runtime",
    ecosystemPath: "/tmp/runtime/runtime-data/components/services/server/pm2-runtime/ecosystem.config.cjs",
    envFilePath: "/tmp/runtime/runtime-data/components/services/server/pm2-runtime/.env"
  })),
  renderManagedPm2StatusText: vi.fn(() => "pm2 status output"),
  renderManagedPm2EnvironmentText: vi.fn(() => "pm2 env output"),
  supportedPm2Services: ["server", "omniroute", "code-server"]
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
        "server",
        "restart",
        "--runtime-root",
        "/tmp/runtime-root"
      ])

    expect(pm2ManagerMocks.runManagedPm2Command).toHaveBeenCalledWith({
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root",
      service: "server",
      action: "restart"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "pm2 status output"
    )

    stdout.mockRestore()
  })

  it("prints the reusable startup environment for a managed service", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "pm2",
      "server",
      "env",
      "--runtime-root",
      "/tmp/runtime-root"
    ])

    expect(pm2ManagerMocks.resolveManagedPm2Environment).toHaveBeenCalledWith({
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root",
      service: "server"
    })
    expect(pm2ManagerMocks.runManagedPm2Command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        service: "server",
        action: "env"
      })
    )
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain("pm2 env output")

    stdout.mockRestore()
  })
})
