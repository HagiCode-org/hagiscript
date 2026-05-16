import { describe, expect, it, vi } from "vitest"

const manifestManagerMocks = vi.hoisted(() => ({
  readRuntimeManifestSummary: vi.fn(async () => ({
    manifestPath: "/tmp/hagiscript.manifest.yaml",
    runtime: {
      name: "fixture-runtime",
      version: "1.0.0",
      hagicodeInstance: "fixture"
    },
    paths: {
      runtimeRoot: "~/.hagicode/runtime",
      runtimeHome: "program",
      runtimeDataRoot: "runtime-data",
      serverProgramRoot: "server",
      serverDataRoot: "server-data",
      npmPrefix: "npm"
    },
    serverActiveVersion: "1.2.3",
    components: ["node", "server"],
    npmPackages: [{ packageName: "pm2", version: "7.0.1", target: "7.0.1" }]
  })),
  renderRuntimeManifestSummaryText: vi.fn(() => "Manifest.\nPath: /tmp/hagiscript.manifest.yaml"),
  initRuntimeManifest: vi.fn(async () => ({
    manifestPath: "/tmp/hagiscript.manifest.yaml",
    manifest: {
      manifestPath: "/tmp/hagiscript.manifest.yaml",
      runtime: { name: "fixture-runtime", version: "1.0.0" }
    },
    changedFields: ["paths.runtimeHome", "npmSync.packages.pm2"]
  })),
  updateRuntimeManifest: vi.fn(async () => ({
    manifestPath: "/tmp/hagiscript.manifest.yaml",
    manifest: {
      manifestPath: "/tmp/hagiscript.manifest.yaml",
      runtime: { name: "fixture-runtime", version: "1.0.0" }
    },
    changedFields: ["components.server.releasedService.activeVersion"]
  })),
  RuntimeManifestMutationError: class RuntimeManifestMutationError extends Error {}
}))

vi.mock("../runtime/manifest-manager.js", () => manifestManagerMocks)

import { createCli, runCli } from "../cli.js"

describe("manifest CLI commands", () => {
  it("includes the manifest command group in help output", () => {
    const cli = createCli()
    const output = cli.helpInformation()
    const manifestHelp = cli.commands.find((command) => command.name() === "manifest")?.helpInformation()

    expect(output).toContain("manifest")
    expect(manifestHelp).toContain("get")
    expect(manifestHelp).toContain("init")
    expect(manifestHelp).toContain("set")
  })

  it("prints a friendly manifest summary", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "manifest",
      "get",
      "./custom.manifest.yaml"
    ])

    expect(manifestManagerMocks.readRuntimeManifestSummary).toHaveBeenCalledWith(
      "./custom.manifest.yaml"
    )
    expect(manifestManagerMocks.renderRuntimeManifestSummaryText).toHaveBeenCalled()
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "Manifest."
    )

    stdout.mockRestore()
  })

  it("passes init options to the manifest manager", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "manifest",
      "init",
      "./custom.manifest.yaml",
      "--runtime-home",
      "program-alt",
      "--runtime-data-root",
      "runtime-data-alt",
      "--npm-package-version",
      "pm2=7.0.2",
      "--server-active-version",
      "1.2.3",
      "--force"
    ])

    expect(manifestManagerMocks.initRuntimeManifest).toHaveBeenCalledWith({
      manifestPath: "./custom.manifest.yaml",
      pathUpdates: {
        runtimeRoot: undefined,
        runtimeHome: "program-alt",
        runtimeDataRoot: "runtime-data-alt",
        serverProgramRoot: undefined,
        serverDataRoot: undefined
      },
      npmPackageUpdates: [
        {
          packageName: "pm2",
          version: "7.0.2",
          target: "7.0.2"
        }
      ],
      serverActiveVersion: "1.2.3",
      force: true
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "Manifest initialized"
    )

    stdout.mockRestore()
  })

  it("passes update options to the manifest manager", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runCli([
      "node",
      "hagiscript",
      "manifest",
      "set",
      "./custom.manifest.yaml",
      "--server-program-root",
      "server-alt",
      "--server-data-root",
      "server-data-alt",
      "--server-active-version",
      "2.0.0"
    ])

    expect(manifestManagerMocks.updateRuntimeManifest).toHaveBeenCalledWith({
      manifestPath: "./custom.manifest.yaml",
      pathUpdates: {
        runtimeRoot: undefined,
        runtimeHome: undefined,
        runtimeDataRoot: undefined,
        serverProgramRoot: "server-alt",
        serverDataRoot: "server-data-alt"
      },
      npmPackageUpdates: [],
      serverActiveVersion: "2.0.0"
    })
    expect(stdout.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      "Manifest updated"
    )

    stdout.mockRestore()
  })
})