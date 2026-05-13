import { describe, expect, it, vi } from "vitest"

const serverManagerMocks = vi.hoisted(() => ({
  installManagedServer: vi.fn(async () => ({
    source: {
      kind: "github-release",
      locator: "HagiCode-org/releases@v1.2.3",
      version: "v1.2.3",
      assetName: "hagicode-1.2.3-linux-x64-nort.zip"
    },
    stagedPath: "/tmp/runtime-root/program/components/server/current",
    stagedDllPath: "/tmp/runtime-root/program/components/server/current/lib/PCode.Web.dll",
    runtimeLifecycle: {
      paths: { root: "/tmp/runtime-root" },
      changedComponents: ["node", "dotnet", "server"],
      logFilePath: "/tmp/runtime-root/runtime-data/logs/install.log"
    },
    runtimeState: {
      ready: true
    },
    pm2: {
      ensured: true,
      versionRange: "*"
    }
  })),
  startManagedServer: vi.fn(async () => ({
    service: "server",
    action: "start",
    baseAppName: "fixture-server",
    appName: "fixture-server-demo",
    nameIdentifierEnv: "hagicode_pm2_name",
    nameIdentifier: "demo",
    cwd: "/tmp/runtime-root/program/components/server/current/lib",
    script: "/tmp/runtime-root/program/components/server/current/lib/PCode.Web.dll",
    runtimeHome: "/tmp/runtime-root/program",
    runtimeDataHome: "/tmp/runtime-root/runtime-data/components/services/server",
    pm2Home: "/tmp/runtime-root/runtime-data/components/services/server/.pm2",
    pm2Binary: "/tmp/runtime-root/program/npm/bin/pm2",
    exists: true,
    status: "online",
    pid: 4242,
    stdout: "[]",
    stderr: "",
    launchStrategy: "released-service"
  })),
  restartManagedServer: vi.fn(),
  stopManagedServer: vi.fn(),
  getManagedServerStatus: vi.fn(async () => ({
    service: "server",
    action: "status",
    baseAppName: "fixture-server",
    appName: "fixture-server-demo",
    nameIdentifierEnv: "hagicode_pm2_name",
    nameIdentifier: "demo",
    cwd: "/tmp/runtime-root/program/components/server/current/lib",
    script: "/tmp/runtime-root/program/components/server/current/lib/PCode.Web.dll",
    runtimeHome: "/tmp/runtime-root/program",
    runtimeDataHome: "/tmp/runtime-root/runtime-data/components/services/server",
    pm2Home: "/tmp/runtime-root/runtime-data/components/services/server/.pm2",
    pm2Binary: "/tmp/runtime-root/program/npm/bin/pm2",
    exists: true,
    status: "online",
    pid: 4242,
    stdout: "[]",
    stderr: "",
    launchStrategy: "released-service"
  })),
  resolveManagedServerStartupEnvironment: vi.fn(async () => ({
    service: "server",
    baseAppName: "fixture-server",
    appName: "fixture-server-demo",
    nameIdentifierEnv: "hagicode_pm2_name",
    nameIdentifier: "demo",
    bootstrapNameIdentifierValue: "hagicode",
    cwd: "/tmp/runtime-root/program/components/server/current/lib",
    script: "/tmp/runtime-root/program/components/server/current/lib/PCode.Web.dll",
    args: [],
    env: {
      HAGICODE_RUNTIME_HOME: "/tmp/runtime-root/program",
      hagicode_pm2_name: "demo"
    },
    pathKey: "PATH",
    pathEntries: ["/tmp/runtime-root/program/bin"],
    runtimeHome: "/tmp/runtime-root/program",
    runtimeDataHome: "/tmp/runtime-root/runtime-data/components/services/server",
    componentRoot: "/tmp/runtime-root/program/components/server",
    componentConfigDir: "/tmp/runtime-root/runtime-data/components/services/server/config",
    pm2Home: "/tmp/runtime-root/runtime-data/components/services/server/.pm2",
    pm2Binary: "/tmp/runtime-root/program/npm/bin/pm2",
    nodePath: "/tmp/runtime-root/program/components/node/bin/node",
    launchStrategy: "released-service"
  }))
}))

const pm2ManagerMocks = vi.hoisted(() => ({
  renderManagedPm2StatusText: vi.fn(() => "server status output"),
  renderManagedPm2EnvironmentText: vi.fn(() => "server env output"),
  supportedPm2Services: ["server", "omniroute", "code-server"],
  runManagedPm2Command: vi.fn(),
  resolveManagedPm2Environment: vi.fn()
}))

vi.mock("../runtime/server-manager.js", () => serverManagerMocks)
vi.mock("../runtime/pm2-manager.js", () => pm2ManagerMocks)

import { createCli, runCli } from "../cli.js"

describe("server CLI commands", () => {
  it("includes the server command group in help output", () => {
    const cli = createCli()
    const output = cli.helpInformation()
    const serverHelp = cli.commands.find((command) => command.name() === "server")?.helpInformation()

    expect(output).toContain("server")
    expect(serverHelp).toContain("install")
    expect(serverHelp).toContain("start")
    expect(serverHelp).toContain("env")
  })

  it("passes install options to the server manager", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "install",
      "--runtime-root",
      "/tmp/runtime-root",
      "--package-dir",
      "/tmp/packages",
      "--pm2-version",
      "^6.0.0",
      "--registry-mirror",
      "https://registry.npmmirror.com/",
      "--force"
    ])

    expect(serverManagerMocks.installManagedServer).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRoot: "/tmp/runtime-root",
        packageDirectory: "/tmp/packages",
        pm2Version: "^6.0.0",
        registryMirror: "https://registry.npmmirror.com/",
        force: true
      })
    )
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "Server install complete."
    )

    stdout.mockRestore()
  })

  it("passes the explicit instance into server env resolution", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "env",
      "--runtime-root",
      "/tmp/runtime-root",
      "--instance",
      "demo"
    ])

    expect(serverManagerMocks.resolveManagedServerStartupEnvironment).toHaveBeenCalledWith({
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root",
      instanceName: "demo"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "server env output"
    )

    stdout.mockRestore()
  })
})
