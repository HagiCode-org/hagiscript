import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCli, runCli } from "../cli.js";
import { NpmCommandError } from "../runtime/npm-global.js";
import { NpmSyncCommandError } from "../runtime/npm-sync.js";
import type { RuntimeState } from "../runtime/runtime-state.js";

const { syncNpmGlobals } = vi.hoisted(() => ({
  syncNpmGlobals: vi.fn(async ({ onLog, registryMirror, fallbackPolicy }) => {
    onLog?.({
      type: "manifest-loaded",
      manifestPath: "/tmp/manifest.json",
      packageCount: 2,
      syncMode: "packages",
      registryMirror
    });
    if (registryMirror) {
      onLog?.({
        type: "fallback-policy",
        fallbackPolicy,
        registryMirror,
        fallbackRegistry: "https://registry.npmjs.org/"
      });
      if (fallbackPolicy === "mirror-only") {
        onLog?.({
          type: "mirror-only",
          registryMirror
        });
      }
    }
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
        fallbackPolicy,
        fallbackUsed: false,
        fallbackEvents: [],
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
  resolveManagedNodeRuntime: vi.fn(async ({ targetDirectory }) => ({
    targetDirectory,
    nodePath: `${targetDirectory}/bin/node`,
    npmPath: `${targetDirectory}/bin/npm`,
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

const { readRuntimeState } = vi.hoisted(() => ({
  readRuntimeState: vi.fn(async () => null as RuntimeState | null)
}));

vi.mock("../runtime/runtime-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/runtime-state.js")>()),
  readRuntimeState
}));

describe("npm-sync CLI command", () => {
  const defaultRuntimeRoot = path.join(homedir(), ".hagicode", "runtime");
  const defaultRuntimeDataRoot = path.join(homedir(), ".hagicode", "runtime-data");
  const defaultNodeRuntime = path.join(
    defaultRuntimeRoot,
    "program",
    "components",
    "node",
    "runtime"
  );
  const fixtureRuntimeManifestPath = path.resolve(
    fileURLToPath(
      new URL("../../tests/runtime/fixtures/runtime-manifest.yaml", import.meta.url)
    )
  );

  it("appears in help output", () => {
    expect(createCli().helpInformation()).toContain("npm-sync");
  });

  it("defaults to the packaged runtime manifest when no manifest options are provided", async () => {
    syncNpmGlobals.mockClear();
    resolveManagedNodeRuntime.mockClear();
    readRuntimeState.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli(["node", "hagiscript", "npm-sync"]);

    expect(readRuntimeState).toHaveBeenCalledWith(
      path.join(defaultRuntimeDataRoot, "state.json")
    );
    expect(resolveManagedNodeRuntime).toHaveBeenCalledWith({
      targetDirectory: defaultNodeRuntime,
      downloadCacheEnabled: true,
      downloadCacheDirectory: undefined
    });
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: defaultNodeRuntime,
        fallbackPolicy: "auto",
        force: false
      })
    );
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.not.objectContaining({ manifestPath: expect.any(String) })
    );

    stdout.mockRestore();
  });

  it("defaults to the runtime state's manifest path when no manifest options are provided", async () => {
    syncNpmGlobals.mockClear();
    resolveManagedNodeRuntime.mockClear();
    readRuntimeState.mockClear();
    readRuntimeState.mockResolvedValueOnce({
      schemaVersion: 1,
      runtime: {
        name: "fixture-runtime",
        version: "1.0.0",
        manifestPath: fixtureRuntimeManifestPath
      },
      managedRoot: "/tmp/runtime-root",
      managedPaths: {
        root: "/tmp/runtime-root",
        runtimeHome: "/tmp/runtime-root/program",
        runtimeDataRoot: "/tmp/runtime-root/runtime-data",
        serverProgramRoot: "/tmp/runtime-root/server",
        serverDataRoot: "/tmp/runtime-root/server-data",
        bin: "/tmp/runtime-root/program/bin",
        config: "/tmp/runtime-root/runtime-data/config",
        logs: "/tmp/runtime-root/runtime-data/logs",
        data: "/tmp/runtime-root/runtime-data/data",
        stateFile: "/tmp/runtime-root/runtime-data/state.json",
        componentsRoot: "/tmp/runtime-root/program/components",
        componentDataRoot: "/tmp/runtime-root/runtime-data/components",
        defaultPm2Home: "pm2",
        npmPrefix: "/tmp/runtime-root/runtime-data/npm",
        nodeRuntime: "/tmp/runtime-root/program/components/node/runtime",
        dotnetRuntime: "/tmp/runtime-root/program/components/dotnet/runtime",
        vendoredRoot: "/tmp/runtime-root/program/components/bundled"
      },
      components: {},
      lastOperation: null
    });
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "npm-sync",
      "--runtime-root",
      "/tmp/runtime-root"
    ]);

    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeManifestPath: fixtureRuntimeManifestPath,
        runtimePath: "/tmp/runtime-root/program/components/node/runtime",
        npmOptions: {
          prefix: "/tmp/runtime-root/runtime-data/npm"
        }
      })
    );

    stdout.mockRestore();
  });

  it("keeps manifest lookup on the runtime root even when --managed-runtime is explicit", async () => {
    syncNpmGlobals.mockClear();
    resolveManagedNodeRuntime.mockClear();
    readRuntimeState.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "npm-sync",
      "--managed-runtime",
      "/tmp/runtime-root/program/components/node/runtime"
    ]);

    expect(readRuntimeState).toHaveBeenCalledWith(
      path.join(defaultRuntimeDataRoot, "state.json")
    );
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/runtime-root/program/components/node/runtime",
        npmOptions: {
          prefix: path.join(defaultRuntimeDataRoot, "npm")
        }
      })
    );

    stdout.mockRestore();
  });

  it("passes an explicit runtime manifest path into npm-sync", async () => {
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
      "--from-manifest",
      ` ${fixtureRuntimeManifestPath} `
    ]);

    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/runtime",
        runtimeManifestPath: fixtureRuntimeManifestPath,
        fallbackPolicy: "auto"
      })
    );

    stdout.mockRestore();
  });

  it("fails before npm sync when both manifest sources are provided", async () => {
    syncNpmGlobals.mockClear();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCli([
        "node",
        "hagiscript",
        "npm-sync",
        "--manifest",
        "/tmp/manifest.json",
        "--from-manifest",
        "/tmp/runtime-manifest.yaml"
      ])
    ).rejects.toThrow("--manifest and --from-manifest cannot be used together.");
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
        registryMirror: "https://registry.npmmirror.com/",
        fallbackPolicy: "auto"
      })
    );
    expect(output).toContain(
      "Manifest validated: /tmp/manifest.json (2 packages, mode=packages)"
    );
    expect(output).toContain("Plan: openspec noop installed=1.0.0");
    expect(output).toContain("Registry mirror: https://registry.npmmirror.com/");
    expect(output).toContain("Fallback policy: auto");
    expect(output).toContain("Fallback used: no");
    expect(output).toContain("npm-sync complete.");

    stdout.mockRestore();
  });

  it("passes force mode through to npm-sync runtime options", async () => {
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
      "--force"
    ]);

    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/runtime",
        manifestPath: "/tmp/manifest.json",
        force: true,
        fallbackPolicy: "auto"
      })
    );

    stdout.mockRestore();
  });

  it("defaults force mode to false when the CLI option is omitted", async () => {
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
      expect.objectContaining({ force: false })
    );

    stdout.mockRestore();
  });

  it("passes a validated npm prefix into npm-sync runtime options", async () => {
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
      "--prefix",
      " /tmp/npm prefix with spaces "
    ]);

    expect(resolveManagedNodeRuntime).not.toHaveBeenCalled();
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/runtime",
        manifestPath: "/tmp/manifest.json",
        npmOptions: {
          prefix: "/tmp/npm prefix with spaces"
        }
      })
    );

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
      "/tmp/manifest.json",
      "--download-cache-dir",
      "/tmp/download-cache"
    ]);

    expect(resolveManagedNodeRuntime).toHaveBeenCalledWith({
      targetDirectory: defaultNodeRuntime,
      downloadCacheEnabled: true,
      downloadCacheDirectory: "/tmp/download-cache"
    });
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: defaultNodeRuntime,
        manifestPath: "/tmp/manifest.json",
        fallbackPolicy: "auto"
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
      expect.objectContaining({ fallbackPolicy: "auto" })
    );
    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.not.objectContaining({ registryMirror: expect.any(String) })
    );
    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(output).not.toContain("Registry mirror:");
    expect(output).not.toContain("Fallback policy:");

    stdout.mockRestore();
  });

  it("does not pass npm options when --prefix is omitted", async () => {
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
      expect.not.objectContaining({ npmOptions: expect.any(Object) })
    );

    stdout.mockRestore();
  });

  it("prints fallback-visible output when the official retry succeeds", async () => {
    syncNpmGlobals.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    syncNpmGlobals.mockImplementationOnce(async ({ onLog, registryMirror, fallbackPolicy }) => {
      onLog?.({
        type: "manifest-loaded",
        manifestPath: "/tmp/manifest.json",
        packageCount: 1,
        syncMode: "packages",
        registryMirror
      });
      onLog?.({
        type: "fallback-policy",
        fallbackPolicy,
        registryMirror,
        fallbackRegistry: "https://registry.npmjs.org/"
      });
      onLog?.({
        type: "fallback-used",
        fallback: {
          commandKind: "inventory",
          mirrorRegistry: "https://registry.npmmirror.com/",
          fallbackRegistry: "https://registry.npmjs.org/",
          retrySucceeded: true
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
          packageCount: 1,
          syncMode: "packages",
          registryMirror,
          fallbackPolicy,
          fallbackUsed: true,
          fallbackEvents: [
            {
              commandKind: "inventory",
              mirrorRegistry: "https://registry.npmmirror.com/",
              fallbackRegistry: "https://registry.npmjs.org/",
              retrySucceeded: true
            }
          ],
          noopCount: 1,
          changedCount: 0,
          actions: []
        }
      });
    });

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
    expect(output).toContain(
      "Fallback used: inventory mirror=https://registry.npmmirror.com/ fallback=https://registry.npmjs.org/ success=true"
    );
    expect(output).toContain("Fallback detail: inventory mirror=https://registry.npmmirror.com/ fallback=https://registry.npmjs.org/ success=true");

    stdout.mockRestore();
  });

  it("supports mirror-only mode and prints deterministic mirror-only output", async () => {
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
      "/tmp/manifest.json",
      "--registry-mirror",
      "https://registry.npmmirror.com/",
      "--mirror-only"
    ]);

    expect(syncNpmGlobals).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/tmp/runtime",
        manifestPath: "/tmp/manifest.json",
        registryMirror: "https://registry.npmmirror.com/",
        fallbackPolicy: "mirror-only"
      })
    );
    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("Fallback policy: mirror-only");
    expect(output).toContain(
      "Mirror-only: official registry fallback disabled for https://registry.npmmirror.com/"
    );
    expect(output).toContain("Fallback used: no");

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
        runtimePath: defaultNodeRuntime,
        manifestPath: expect.stringContaining("hagiscript-tool-sync-"),
        fallbackPolicy: "auto"
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

  it("fails before npm sync when --prefix is blank", async () => {
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
        "--prefix",
        " "
      ])
    ).rejects.toThrow("--prefix must be a non-empty path.");
    expect(syncNpmGlobals).not.toHaveBeenCalled();

    stderr.mockRestore();
  });

  it("fails before npm sync when --prefix contains a null byte", async () => {
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
        "--prefix",
        "/tmp/npm\0prefix"
      ])
    ).rejects.toThrow("--prefix contains an invalid null byte.");
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

  it("prints enriched retry diagnostics for terminal double-failure errors", async () => {
    syncNpmGlobals.mockClear();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    syncNpmGlobals.mockRejectedValueOnce(
      new NpmSyncCommandError(
        "Failed to list npm global packages",
        new NpmCommandError("official failed", {
          command: "/tmp/runtime/bin/npm",
          args: [
            "list",
            "-g",
            "--depth=0",
            "--json",
            "--registry",
            "https://registry.npmjs.org/"
          ],
          stdout: "official stdout",
          stderr: "official stderr",
          exitCode: 1
        }),
        {
          fallbackPolicy: "auto",
          registryMirror: "https://registry.npmmirror.com/",
          fallbackRegistry: "https://registry.npmjs.org/",
          mirrorError: new NpmCommandError("mirror failed", {
            command: "/tmp/runtime/bin/npm",
            args: [
              "list",
              "-g",
              "--depth=0",
              "--json",
              "--registry",
              "https://registry.npmmirror.com/"
            ],
            stdout: "mirror stdout",
            stderr: "mirror stderr",
            exitCode: 1
          }),
          officialError: new NpmCommandError("official failed", {
            command: "/tmp/runtime/bin/npm",
            args: [
              "list",
              "-g",
              "--depth=0",
              "--json",
              "--registry",
              "https://registry.npmjs.org/"
            ],
            stdout: "official stdout",
            stderr: "official stderr",
            exitCode: 1
          })
        }
      )
    );

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
        "https://registry.npmmirror.com/"
      ])
    ).rejects.toThrow();

    const output = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("Registry mirror: https://registry.npmmirror.com/");
    expect(output).toContain("Fallback registry: https://registry.npmjs.org/");
    expect(output).toContain("Mirror command: /tmp/runtime/bin/npm list -g --depth=0 --json --registry https://registry.npmmirror.com/");
    expect(output).toContain("Official retry command: /tmp/runtime/bin/npm list -g --depth=0 --json --registry https://registry.npmjs.org/");
    expect(output).toContain("mirror stderr: mirror stderr");
    expect(output).toContain("official stderr: official stderr");

    stderr.mockRestore();
  });
});
