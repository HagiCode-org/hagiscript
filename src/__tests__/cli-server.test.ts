import { describe, expect, it, vi } from "vitest"

const serverManagerMocks = vi.hoisted(() => ({
  installManagedServer: vi.fn(async () => ({
    source: {
      kind: "github-release",
      locator: "HagiCode-org/releases@v1.2.3",
      version: "v1.2.3",
      assetName: "hagicode-1.2.3-linux-x64-nort.zip"
    },
    installedVersion: "1.2.3",
    activeVersion: "1.2.3",
    stagedPath: "/tmp/runtime-root/program/server/versions/1.2.3",
    stagedDllPath: "/tmp/runtime-root/program/server/versions/1.2.3/lib/PCode.Web.dll",
    statePath: "/tmp/runtime-root/runtime-data/server/versions-state.json",
    sharedDataRoot: "/tmp/runtime-root/runtime-data/server",
    runtimeLifecycle: {
      paths: { root: "/tmp/runtime-root" },
      changedComponents: ["node", "dotnet"],
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
    nameIdentifierEnv: "hagicode_instance",
    nameIdentifier: "demo",
    cwd: "/tmp/runtime-root/program/server/versions/1.2.3/lib",
    script: "/tmp/runtime-root/program/server/versions/1.2.3/lib/PCode.Web.dll",
    runtimeHome: "/tmp/runtime-root/program",
    runtimeDataHome: "/tmp/runtime-root/runtime-data/server",
    pm2Home: "/tmp/runtime-root/runtime-data/server/.pm2",
    pm2Binary: "/tmp/runtime-root/runtime-data/npm/bin/pm2",
    exists: true,
    status: "online",
    pid: 4242,
    stdout: "[]",
    stderr: "",
    launchStrategy: "released-service"
  })),
  restartManagedServer: vi.fn(),
  stopManagedServer: vi.fn(),
  listManagedServerVersions: vi.fn(async () => ({
    activeVersion: "1.2.3",
    versions: [
      {
        version: "1.2.3",
        installPath: "/tmp/runtime-root/program/server/versions/1.2.3",
        installedAt: "2026-05-13T00:00:00.000Z",
        source: {
          kind: "github-release",
          locator: "HagiCode-org/releases@v1.2.3",
          assetName: "hagicode-1.2.3-linux-x64-nort.zip"
        },
        active: true
      }
    ],
    statePath: "/tmp/runtime-root/runtime-data/server/versions-state.json",
    sharedDataRoot: "/tmp/runtime-root/runtime-data/server"
  })),
  useManagedServerVersion: vi.fn(async () => ({
    previousActiveVersion: "1.2.2",
    activeVersion: "1.2.3",
    statePath: "/tmp/runtime-root/runtime-data/server/versions-state.json"
  })),
  removeManagedServerInstalledVersion: vi.fn(async () => ({
    activeVersion: "1.2.3",
    removedVersion: "1.2.2",
    removedPath: "/tmp/runtime-root/program/server/versions/1.2.2",
    statePath: "/tmp/runtime-root/runtime-data/server/versions-state.json"
  })),
  getManagedServerStatus: vi.fn(async () => ({
    service: "server",
    action: "status",
    baseAppName: "fixture-server",
    appName: "fixture-server-demo",
    nameIdentifierEnv: "hagicode_instance",
    nameIdentifier: "demo",
    cwd: "/tmp/runtime-root/program/server/versions/1.2.3/lib",
    script: "/tmp/runtime-root/program/server/versions/1.2.3/lib/PCode.Web.dll",
    runtimeHome: "/tmp/runtime-root/program",
    runtimeDataHome: "/tmp/runtime-root/runtime-data/server",
    pm2Home: "/tmp/runtime-root/runtime-data/server/.pm2",
    pm2Binary: "/tmp/runtime-root/runtime-data/npm/bin/pm2",
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
    nameIdentifierEnv: "hagicode_instance",
    nameIdentifier: "demo",
    bootstrapNameIdentifierValue: "hagicode",
    cwd: "/tmp/runtime-root/program/server/versions/1.2.3/lib",
    script: "/tmp/runtime-root/program/server/versions/1.2.3/lib/PCode.Web.dll",
    args: [],
    env: {
      HAGICODE_RUNTIME_HOME: "/tmp/runtime-root/program",
      hagicode_instance: "demo"
    },
    pathKey: "PATH",
    pathEntries: ["/tmp/runtime-root/program/bin"],
    runtimeHome: "/tmp/runtime-root/program",
    runtimeDataHome: "/tmp/runtime-root/runtime-data/server",
    componentRoot: "/tmp/runtime-root/program/server/versions/1.2.3",
    componentConfigDir: "/tmp/runtime-root/runtime-data/server/config",
    pm2Home: "/tmp/runtime-root/runtime-data/server/.pm2",
    pm2Binary: "/tmp/runtime-root/runtime-data/npm/bin/pm2",
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

const serverConfigMocks = vi.hoisted(() => ({
  getManagedServerConfig: vi.fn(async () => ({
    host: "127.0.0.1",
    port: 39150,
    aspNetCoreUrls: "http://127.0.0.1:39150",
    configPath: "/tmp/runtime-root/runtime-data/server/config/server-config.json",
    source: "config-file"
  })),
  setManagedServerConfig: vi.fn(async () => ({
    host: "0.0.0.0",
    port: 39160,
    aspNetCoreUrls: "http://0.0.0.0:39160",
    configPath: "/tmp/runtime-root/runtime-data/server/config/server-config.json",
    source: "config-file"
  }))
}))

vi.mock("../runtime/server-manager.js", () => serverManagerMocks)
vi.mock("../runtime/pm2-manager.js", () => pm2ManagerMocks)
vi.mock("../runtime/server-config.js", () => serverConfigMocks)

import { createCli, runCli } from "../cli.js"

describe("server CLI commands", () => {
  it("includes the server command group in help output", () => {
    const cli = createCli()
    const output = cli.helpInformation()
    const serverHelp = cli.commands.find((command) => command.name() === "server")?.helpInformation()

    expect(output).toContain("server")
    expect(serverHelp).toContain("install")
    expect(serverHelp).toContain("list")
    expect(serverHelp).toContain("use")
    expect(serverHelp).toContain("remove")
    expect(serverHelp).toContain("start")
    expect(serverHelp).toContain("env")
    expect(serverHelp).toContain("config")
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
      "^7.0.0",
      "--registry-mirror",
      "https://registry.npmmirror.com/",
      "--force"
    ])

    expect(serverManagerMocks.installManagedServer).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRoot: "/tmp/runtime-root",
        packageDirectory: "/tmp/packages",
        pm2Version: "^7.0.0",
        registryMirror: "https://registry.npmmirror.com/",
        force: true
      })
    )
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "Server install complete."
    )

    stdout.mockRestore()
  })

  it("passes HTTP index options to the server manager", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "install",
      "--runtime-root",
      "/tmp/runtime-root",
      "--index-url",
      "https://index.example.com/hagicode/index.json",
      "--index-channel",
      "stable",
      "--index-version",
      "1.2.3"
    ])

    expect(serverManagerMocks.installManagedServer).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRoot: "/tmp/runtime-root",
        indexUrl: "https://index.example.com/hagicode/index.json",
        indexChannel: "stable",
        indexVersion: "1.2.3"
      })
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

  it("lists installed server versions", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "list",
      "--runtime-root",
      "/tmp/runtime-root"
    ])

    expect(serverManagerMocks.listManagedServerVersions).toHaveBeenCalledWith({
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "Managed server versions."
    )

    stdout.mockRestore()
  })

  it("activates an installed server version", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "use",
      "1.2.3",
      "--runtime-root",
      "/tmp/runtime-root"
    ])

    expect(serverManagerMocks.useManagedServerVersion).toHaveBeenCalledWith({
      version: "1.2.3",
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "Managed server version activated."
    )

    stdout.mockRestore()
  })

  it("removes an installed server version", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "remove",
      "1.2.2",
      "--runtime-root",
      "/tmp/runtime-root"
    ])

    expect(serverManagerMocks.removeManagedServerInstalledVersion).toHaveBeenCalledWith({
      version: "1.2.2",
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "Managed server version removed."
    )

    stdout.mockRestore()
  })

  it("reads managed server config", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "config",
      "get",
      "--runtime-root",
      "/tmp/runtime-root"
    ])

    expect(serverConfigMocks.getManagedServerConfig).toHaveBeenCalledWith({
      manifestPath: undefined,
      runtimeRoot: "/tmp/runtime-root"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "Managed server config."
    )

    stdout.mockRestore()
  })

  it("updates managed server config", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "server",
      "config",
      "set",
      "--runtime-root",
      "/tmp/runtime-root",
      "--host",
      "0.0.0.0",
      "--port",
      "39160"
    ])

    expect(serverConfigMocks.setManagedServerConfig).toHaveBeenCalledWith(
      {
        host: "0.0.0.0",
        port: 39160
      },
      {
        manifestPath: undefined,
        runtimeRoot: "/tmp/runtime-root"
      }
    )
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "ASPNETCORE_URLS: http://0.0.0.0:39160"
    )

    stdout.mockRestore()
  })
})
