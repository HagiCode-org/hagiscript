import { describe, expect, it, vi } from "vitest"

const runtimeManagerMocks = vi.hoisted(() => ({
  installRuntime: vi.fn(async () => ({
    manifest: {
      manifestPath: "/tmp/runtime.yaml",
      runtime: { name: "fixture-runtime", version: "1.0.0" }
    },
    paths: { root: "/tmp/runtime-root" },
    plan: [{ componentName: "alpha" }],
    skipped: [],
    changedComponents: []
  })),
  removeRuntime: vi.fn(async () => ({
    manifest: {
      manifestPath: "/tmp/runtime.yaml",
      runtime: { name: "fixture-runtime", version: "1.0.0" }
    },
    paths: { root: "/tmp/runtime-root" },
    plan: [{ componentName: "alpha" }],
    skipped: [],
    changedComponents: ["alpha"],
    logFilePath: "/tmp/runtime-root/logs/remove.log"
  })),
  updateRuntime: vi.fn(async () => ({
    manifest: {
      manifestPath: "/tmp/runtime.yaml",
      runtime: { name: "fixture-runtime", version: "1.0.0" }
    },
    paths: { root: "/tmp/runtime-root" },
    plan: [{ componentName: "alpha" }],
    skipped: [{ componentName: "beta", reason: "already up to date" }],
    changedComponents: []
  })),
  queryRuntimeState: vi.fn(async () => ({
    runtime: {
      name: "fixture-runtime",
      version: "1.0.0",
      manifestPath: "/tmp/runtime.yaml"
    },
    managedRoot: "/tmp/runtime-root",
    managedPaths: {
      root: "/tmp/runtime-root",
      bin: "/tmp/runtime-root/bin",
      config: "/tmp/runtime-root/config",
      logs: "/tmp/runtime-root/logs",
      data: "/tmp/runtime-root/data",
      stateFile: "/tmp/runtime-root/state.json",
      componentsRoot: "/tmp/runtime-root/components",
      npmPrefix: "/tmp/runtime-root/data/npm",
      nodeRuntime: "/tmp/runtime-root/components/node",
      dotnetRuntime: "/tmp/runtime-root/components/dotnet",
      vendoredRoot: "/tmp/runtime-root/components/services"
    },
    ready: false,
    components: [
      {
        name: "alpha",
        type: "bundled-runtime",
        status: "installed",
        version: "1.0.0",
        managedPaths: ["/tmp/runtime-root/components/services/alpha"]
      }
    ],
    lastOperation: null
  })),
  renderRuntimeStateText: vi.fn(() => "runtime text output")
}))

vi.mock("../runtime/runtime-manager.js", () => runtimeManagerMocks)

import { createCli, runCli } from "../cli.js"

describe("runtime CLI commands", () => {
  it("includes the runtime command group in help output", () => {
    const cli = createCli()
    const output = cli.helpInformation()
    const runtimeHelp = cli.commands.find((command) => command.name() === "runtime")?.helpInformation()

    expect(output).toContain("runtime")
    expect(runtimeHelp).toContain("install")
    expect(runtimeHelp).toContain("remove")
    expect(runtimeHelp).toContain("update")
    expect(runtimeHelp).toContain("state")
  })

  it("passes lifecycle options to runtime install", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "runtime",
      "install",
      "--components",
      "beta,alpha",
      "--dry-run",
      "--runtime-root",
      "/tmp/runtime-root"
    ])

    expect(runtimeManagerMocks.installRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        components: ["beta", "alpha"],
        dryRun: true,
        runtimeRoot: "/tmp/runtime-root"
      })
    )
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "Runtime install complete (dry-run)."
    )

    stdout.mockRestore()
  })

  it("prints machine-readable runtime state", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "runtime",
      "state",
      "--json"
    ])

    const output = stdout.mock.calls.map(([value]) => String(value)).join("")
    expect(output).toContain('"managedRoot": "/tmp/runtime-root"')
    expect(runtimeManagerMocks.queryRuntimeState).toHaveBeenCalled()

    stdout.mockRestore()
  })
})
