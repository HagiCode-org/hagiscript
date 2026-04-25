import { describe, expect, it, vi } from "vitest";
import { createCli, runCli } from "../cli.js";

const { syncNpmGlobals } = vi.hoisted(() => ({
  syncNpmGlobals: vi.fn(async ({ onLog }) => {
    onLog?.({
      type: "manifest-loaded",
      manifestPath: "/tmp/manifest.json",
      packageCount: 2
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

describe("npm-sync CLI command", () => {
  it("appears in help output", () => {
    expect(createCli().helpInformation()).toContain("npm-sync");
  });

  it("requires runtime and manifest options", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(runCli(["node", "hagiscript", "npm-sync"])).rejects.toThrow();
    expect(syncNpmGlobals).not.toHaveBeenCalled();

    stderr.mockRestore();
  });

  it("prints deterministic sync logs", async () => {
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

    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/runtime",
        manifestPath: "/tmp/manifest.json"
      })
    );
    expect(output).toContain(
      "Manifest validated: /tmp/manifest.json (2 packages)"
    );
    expect(output).toContain("Plan: openspec noop installed=1.0.0");
    expect(output).toContain("npm-sync complete.");

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
});
