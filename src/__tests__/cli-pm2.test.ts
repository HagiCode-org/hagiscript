import { describe, expect, it, vi } from "vitest"

const pm2ManagerMocks = vi.hoisted(() => ({
  runManagedPm2Command: vi.fn(async () => ({
    service: "server",
    action: "restart",
    baseAppName: "fixture-server",
    appName: "fixture-server-fixture",
    nameIdentifierEnv: "hagicode_instance",
    nameIdentifier: "fixture",
    cwd: "/tmp/runtime/program/server/versions/1.2.3/lib",
    script: "/tmp/runtime/program/server/versions/1.2.3/lib/PCode.Web.dll",
    runtimeHome: "/tmp/runtime/program",
    runtimeDataHome: "/tmp/runtime/runtime-data/server",
    pm2Home: "/tmp/runtime/runtime-data/server/.pm2",
    pm2Binary: "/tmp/runtime/runtime-data/npm/bin/pm2",
    launchStrategy: "released-service",
    dotnetPath: "/tmp/runtime/program/components/dotnet/current/dotnet",
    runtimeFilesDir: "/tmp/runtime/runtime-data/server/pm2-runtime",
    exists: true,
    status: "online",
    pid: 4242,
    stdout: "[]",
    stderr: ""
  })),
  resolveManagedPm2Environment: vi.fn(async () => ({
    service: "server",
    baseAppName: "fixture-server",
    appName: "fixture-server-fixture",
    nameIdentifierEnv: "hagicode_instance",
    nameIdentifier: "fixture",
    bootstrapNameIdentifierValue: "hagicode",
    cwd: "/tmp/runtime/program/server/versions/1.2.3/lib",
    script: "/tmp/runtime/program/server/versions/1.2.3/lib/PCode.Web.dll",
    args: [],
    env: {
      HAGICODE_RUNTIME_HOME: "/tmp/runtime/program",
      hagicode_instance: "fixture",
      ASPNETCORE_URLS: "http://127.0.0.1:39150",
      PATH: "/tmp/runtime/program/bin:/usr/bin"
    },
    pathKey: "PATH",
    pathEntries: ["/tmp/runtime/program/components/node/bin", "/tmp/runtime/runtime-data/npm/bin"],
    runtimeHome: "/tmp/runtime/program",
    runtimeDataHome: "/tmp/runtime/runtime-data/server",
    componentRoot: "/tmp/runtime/program/server/versions/1.2.3",
    componentConfigDir: "/tmp/runtime/runtime-data/server/config",
    pm2Home: "/tmp/runtime/runtime-data/server/.pm2",
    pm2Binary: "/tmp/runtime/runtime-data/npm/bin/pm2",
    nodePath: "/tmp/runtime/program/components/node/bin/node",
    launchStrategy: "released-service",
    dotnetPath: "/tmp/runtime/program/components/dotnet/current/dotnet",
    runtimeFilesDir: "/tmp/runtime/runtime-data/server/pm2-runtime",
    ecosystemPath: "/tmp/runtime/runtime-data/server/pm2-runtime/ecosystem.config.cjs",
    envFilePath: "/tmp/runtime/runtime-data/server/pm2-runtime/.env"
  })),
  renderManagedPm2StatusText: vi.fn(() => "pm2 status output"),
  renderManagedPm2EnvironmentText: vi.fn(() => "pm2 env output"),
  supportedPm2Services: ["server", "code-server"]
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

  it("forwards --external-node-path to PM2 actions and to env", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "pm2",
      "server",
      "start",
      "--runtime-root",
      "/tmp/runtime-root",
      "--external-node-path",
      "/opt/node/bin/node"
    ])
    expect(pm2ManagerMocks.runManagedPm2Command).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "start", externalNodePath: "/opt/node/bin/node" })
    )

    await runCli(["node", "hagiscript", "pm2", "server", "env", "--external-node-path", "/opt/node/bin/node"])
    expect(pm2ManagerMocks.resolveManagedPm2Environment).toHaveBeenLastCalledWith(
      expect.objectContaining({ externalNodePath: "/opt/node/bin/node" })
    )

    stdout.mockRestore()
  })

  it("forwards no external Node path when --external-node-path is omitted", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli(["node", "hagiscript", "pm2", "server", "status", "--runtime-root", "/tmp/runtime-root"])

    expect(pm2ManagerMocks.runManagedPm2Command.mock.lastCall?.[0]?.externalNodePath).toBeUndefined()

    stdout.mockRestore()
  })

  it.each([
    ["an empty value", ""],
    ["a null byte", "/opt/node\0/bin/node"]
  ])("rejects %s for --external-node-path before running a PM2 action", async (_label, value) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const callsBefore = pm2ManagerMocks.runManagedPm2Command.mock.calls.length

    await runCli(["node", "hagiscript", "pm2", "server", "start", "--external-node-path", value])

    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("--external-node-path")
    expect(exit).toHaveBeenCalledWith(1)
    expect(pm2ManagerMocks.runManagedPm2Command.mock.calls.length).toBe(callsBefore)

    exit.mockRestore()
    stderr.mockRestore()
  })
})
