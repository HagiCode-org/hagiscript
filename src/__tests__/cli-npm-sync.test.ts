import { describe, expect, it, vi } from "vitest";
import { createCli, runCli } from "../cli.js";

const { syncNpmGlobals } = vi.hoisted(() => ({
  syncNpmGlobals: vi.fn(async ({ onLog, registryMirror }) => {
    onLog?.({
      type: "manifest-loaded",
      manifestPath: "/tmp/manifest.json",
      packageCount: 2,
      syncMode: "packages",
      registryMirror
    });
    onLog?.({
      type: "runtime-valid",
      runtime: {
        targetDirectory: "/tmp/runtime",
        nodePath: "/tmp/runtime/bin/node",
        npmPath: "/tmp/runtime/bin/npm",
        nodeVersion: "v22.0.0",
        npmVersion: "10.0.0"
      }
    });
    onLog?.({ type: "inventory", packages: { openspec: "1.0.0" } });
    onLog?.({
      type: "planned-action",
      action: {
        packageName: "openspec",
        requiredRange: "^1.0.0",
        targetSelector: "^1.0.0",
        selectedInstallSelector: "openspec@^1.0.0",
        installedVersion: "1.0.0",
        action: "noop"
      }
    });
    onLog?.({
      type: "skip",
      action: {
        packageName: "openspec",
        requiredRange: "^1.0.0",
        targetSelector: "^1.0.0",
        selectedInstallSelector: "openspec@^1.0.0",
        installedVersion: "1.0.0",
        action: "noop"
      }
    });
    onLog?.({
      type: "summary",
      summary: {
        runtime: {
          targetDirectory: "/tmp/runtime",
          nodePath: "/tmp/runtime/bin/node",
          npmPath: "/tmp/runtime/bin/npm",
          nodeVersion: "v22.0.0",
          npmVersion: "10.0.0"
        },
        manifestPath: "/tmp/manifest.json",
        packageCount: 2,
        syncMode: "packages",
        registryMirror,
        noopCount: 1,
        changedCount: 1,
        actions: []
      }
    });
  })
}));

vi.mock("../runtime/npm-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/npm-sync.js")>()),
  syncNpmGlobals
}));

const { resolveManagedNodeRuntime } = vi.hoisted(() => ({
  resolveManagedNodeRuntime: vi.fn(async () => ({
    targetDirectory: "/tmp/managed-runtime",
    nodePath: "/tmp/managed-runtime/bin/node",
    npmPath: "/tmp/managed-runtime/bin/npm",
    nodeVersion: "v22.0.0",
    npmVersion: "10.0.0",
    installed: false
  }))
}));

vi.mock("../runtime/node-installer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/node-installer.js")>()),
  getDefaultManagedNodeRuntimeDirectory: () => "/tmp/managed-runtime",
  resolveManagedNodeRuntime
}));

describe("npm-sync CLI command", () => {
  it("appears in help output", () => {
    expect(createCli().helpInformation()).toContain("npm-sync");
  });

  it("requires a manifest or inline tool selection", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(runCli(["node", "hagiscript", "npm-sync"])).rejects.toThrow();
    expect(syncNpmGlobals).not.toHaveBeenCalled();

    stderr.mockRestore();
  });

  it("prints deterministic sync logs", async () => {
    syncNpmGlobals.mockClear();
    resolveManagedNodeRuntime.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "npm-sync",
      "--runtime",
      "/tmp/runtime",
      "--manifest",
      "/tmp/manifest.json",
      "--registry-mirror",
      "https://registry.npmmirror.com/"
    ]);

    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(resolveManagedNodeRuntime).not.toHaveBeenCalled();
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/runtime",
        manifestPath: "/tmp/manifest.json",
        registryMirror: "https://registry.npmmirror.com/"
      })
    );
    expect(output).toContain(
      "Manifest validated: /tmp/manifest.json (2 packages, mode=packages)"
    );
    expect(output).toContain("Plan: openspec noop installed=1.0.0");
    expect(output).toContain("Registry mirror: https://registry.npmmirror.com/");
    expect(output).toContain("npm-sync complete.");

    stdout.mockRestore();
  });

  it("defaults to the managed runtime when --runtime is omitted", async () => {
    syncNpmGlobals.mockClear();
    resolveManagedNodeRuntime.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "npm-sync",
      "--manifest",
      "/tmp/manifest.json"
    ]);

    expect(resolveManagedNodeRuntime).toHaveBeenCalledWith({
      targetDirectory: "/tmp/managed-runtime"
    });
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/managed-runtime",
        manifestPath: "/tmp/manifest.json"
      })
    );

    stdout.mockRestore();
  });

  it("does not pass a registry mirror when the CLI option is omitted", async () => {
    syncNpmGlobals.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "npm-sync",
      "--runtime",
      "/tmp/runtime",
      "--manifest",
      "/tmp/manifest.json"
    ]);

    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.not.objectContaining({ registryMirror: expect.any(String) })
    );
    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(output).not.toContain("Registry mirror:");

    stdout.mockRestore();
  });

  it("builds an inline tool manifest from selected optional CLI arguments", async () => {
    syncNpmGlobals.mockClear();
    resolveManagedNodeRuntime.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "npm-sync",
      "--selected-agent-cli",
      "codex",
      "--custom-agent-cli",
      "@scope/agent-cli@^1.0.0"
    ]);

    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/managed-runtime",
        manifestPath: expect.stringContaining("hagiscript-tool-sync-")
      })
    );

    stdout.mockRestore();
  });

  it("fails before npm sync when an option is blank", async () => {
    syncNpmGlobals.mockClear();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCli([
        "node",
        "hagiscript",
        "npm-sync",
        "--runtime",
        " ",
        "--manifest",
        "/tmp/manifest.json"
      ])
    ).rejects.toThrow();
    expect(syncNpmGlobals).not.toHaveBeenCalled();

    stderr.mockRestore();
  });

  it("fails before npm sync when --registry-mirror is invalid", async () => {
    syncNpmGlobals.mockClear();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCli([
        "node",
        "hagiscript",
        "npm-sync",
        "--runtime",
        "/tmp/runtime",
        "--manifest",
        "/tmp/manifest.json",
        "--registry-mirror",
        "ftp://registry.example.com/"
      ])
    ).rejects.toThrow();
    expect(syncNpmGlobals).not.toHaveBeenCalled();

    stderr.mockRestore();
  });
});
