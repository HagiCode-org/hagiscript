import { access, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  NpmCommandError,
  type NpmCommandResult
} from "../runtime/npm-global.js";
import {
  createNpmSyncPlan,
  loadNpmSyncManifest,
  normalizeGlobalInventory,
  syncNpmGlobals,
  validateNpmSyncManifest
} from "../runtime/npm-sync.js";

describe("npm-sync manifest validation", () => {
  it("loads valid manifests with openspec and skills entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        packages: {
          "@openspec/cli": { version: "^1.2.0", target: "1.2.3" },
          "@hagicode/skills": { version: ">=0.5.0 <1.0.0" }
        }
      })
    );

    const manifest = await loadNpmSyncManifest(manifestPath);

    expect(manifest.packages["@openspec/cli"]).toEqual({
      version: "^1.2.0",
      target: "1.2.3"
    });
    expect(manifest.packages["@hagicode/skills"]).toEqual({
      version: ">=0.5.0 <1.0.0"
    });
    expect(manifest.syncMode).toBe("packages");
  });

  it("loads flat package manifests with a registry mirror", () => {
    const manifest = validateNpmSyncManifest({
      registryMirror: " https://registry.npmmirror.com/ ",
      packages: {
        openspec: { version: "^1.2.0" }
      }
    });

    expect(manifest.registryMirror).toBe("https://registry.npmmirror.com/");
    expect(manifest.packages.openspec).toEqual({ version: "^1.2.0" });
    expect(manifest.syncMode).toBe("packages");
  });

  it("loads product-managed tool manifests with mandatory and selected tools", () => {
    const manifest = validateNpmSyncManifest({
      registryMirror: "https://registry.example.com/",
      tools: {
        optionalAgentCliSyncEnabled: true,
        selectedOptionalAgentCliIds: ["codex", "claude-code", "fission-openspec"],
        customAgentClis: [
          { packageName: "@scope/agent-cli", version: "^2.0.0" }
        ]
      }
    });

    expect(manifest.syncMode).toBe("tools");
    expect(manifest.registryMirror).toBe("https://registry.example.com/");
    expect(Object.keys(manifest.packages)).toEqual([
      "@anthropic-ai/claude-code",
      "@fission-ai/openspec",
      "@openai/codex",
      "@scope/agent-cli",
      "code-server",
      "omniroute",
      "skills"
    ]);
    expect(manifest.packages["@openai/codex"]).toMatchObject({
      version: "0.125.0",
      target: "0.125.0",
      toolId: "codex",
      toolGroup: "optional-agent-cli"
    });
    expect(manifest.packages["@anthropic-ai/claude-code"]).toMatchObject({
      version: "2.1.119",
      target: "2.1.119",
      toolId: "claude-code"
    });
    expect(manifest.packages["@fission-ai/openspec"]).toMatchObject({
      version: "1.3.1",
      target: "1.3.1",
      toolId: "fission-openspec"
    });
  });

  it("allows product-managed tool manifests with empty optional selections", () => {
    const manifest = validateNpmSyncManifest({
      tools: { optionalAgentCliSyncEnabled: true }
    });

    expect(Object.keys(manifest.packages)).toEqual([
      "code-server",
      "omniroute",
      "skills"
    ]);
  });

  it("rejects manifests without packages", () => {
    expect(() => validateNpmSyncManifest({})).toThrow(
      "top-level packages object"
    );
  });

  it("rejects invalid semver ranges", () => {
    expect(() =>
      validateNpmSyncManifest({
        packages: { openspec: { version: "definitely bad" } }
      })
    ).toThrow("not a valid semver range");
  });

  it.each([
    ["blank", " "],
    ["non-string", 42],
    ["relative", "registry.example.com/npm"],
    ["unsupported protocol", "ftp://registry.example.com/"]
  ])("rejects %s registry mirror values", (_caseName, registryMirror) => {
    expect(() =>
      validateNpmSyncManifest({
        registryMirror,
        packages: { openspec: { version: "^1.0.0" } }
      })
    ).toThrow("registryMirror");
  });
});

describe("npm-sync planning", () => {
  const manifest = validateNpmSyncManifest({
    packages: {
      missing: { version: "^1.0.0" },
      noop: { version: "^2.0.0" },
      upgrade: { version: ">=3.0.0 <4.0.0" },
      downgrade: { version: "<5.0.0" },
      ambiguous: { version: "1.0.0 || 3.0.0", target: "3.0.0" }
    }
  });

  it("classifies no-op, install, upgrade, downgrade, and sync actions", () => {
    const plan = createNpmSyncPlan(manifest, {
      noop: "2.4.0",
      upgrade: "2.9.9",
      downgrade: "6.0.0",
      ambiguous: "2.0.0"
    });

    expect(
      Object.fromEntries(
        plan.map((action) => [action.packageName, action.action])
      )
    ).toEqual({
      ambiguous: "sync",
      downgrade: "downgrade",
      missing: "install",
      noop: "noop",
      upgrade: "upgrade"
    });
    expect(
      plan.find((action) => action.packageName === "ambiguous")
        ?.selectedInstallSelector
    ).toBe("ambiguous@3.0.0");
  });

  it("retains originating tool metadata on planned actions", () => {
    const toolManifest = validateNpmSyncManifest({
      tools: {
        optionalAgentCliSyncEnabled: true,
        selectedOptionalAgentCliIds: ["codex"]
      }
    });

    const plan = createNpmSyncPlan(toolManifest, {});

    expect(plan.find((action) => action.packageName === "skills")).toMatchObject({
      action: "install",
      toolId: "openspec-skills",
      toolGroup: "mandatory",
      toolRequirement: "mandatory"
    });
    expect(plan.find((action) => action.packageName === "@openai/codex")).toMatchObject({
      selectedInstallSelector: "@openai/codex@0.125.0",
      toolId: "codex",
      toolGroup: "optional-agent-cli"
    });
  });
});

describe("npm-sync execution", () => {
  it("normalizes npm inventory output", () => {
    expect(
      normalizeGlobalInventory(
        JSON.stringify({
          dependencies: {
            openspec: { version: "1.0.0" },
            ignored: {}
          }
        })
      )
    ).toEqual({ openspec: "1.0.0" });
  });

  it("skips npm install for no-op packages and returns a summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ packages: { openspec: { version: "^1.0.0" } } })
    );
    const runner = vi.fn(async (_command: string, args: string[]) => {
      expect(args[0]).toBe("list");
      return commandResult("/runtime/bin/npm", args, {
        dependencies: { openspec: { version: "1.1.0" } }
      });
    });

    const summary = await syncNpmGlobals({
      runtimePath: "/runtime",
      manifestPath,
      verifyRuntime: vi.fn(async () => ({
        valid: true,
        targetDirectory: "/runtime",
        nodePath: "/runtime/bin/node",
        npmPath: "/runtime/bin/npm",
        nodeVersion: "v22.0.0",
        npmVersion: "10.0.0"
      })),
      npmOptions: { runCommand: runner }
    });

    expect(summary.noopCount).toBe(1);
    expect(summary.syncMode).toBe("packages");
    expect(summary.changedCount).toBe(0);
    expect(summary.fallbackPolicy).toBe("auto");
    expect(summary.fallbackUsed).toBe(false);
    expect(summary.fallbackEvents).toEqual([]);
    expect(summary.registryMirror).toBeUndefined();
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][1]).toEqual(["list", "-g", "--depth=0", "--json"]);
  });

  it("passes manifest registry mirror to inventory and install commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        registryMirror: "https://registry.npmmirror.com/",
        packages: { openspec: { version: "^1.0.0", target: "1.2.3" } }
      })
    );
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "list") {
        return commandResult(command, args, { dependencies: {} });
      }

      return commandResult(command, args, {});
    });

    const summary = await syncNpmGlobals({
      runtimePath: "/runtime",
      manifestPath,
      verifyRuntime: vi.fn(async () => ({
        valid: true,
        targetDirectory: "/runtime",
        nodePath: "/runtime/bin/node",
        npmPath: "/runtime/bin/npm",
        nodeVersion: "v22.0.0",
        npmVersion: "10.0.0"
      })),
      npmOptions: { runCommand: runner }
    });

    expect(summary.registryMirror).toBe("https://registry.npmmirror.com/");
    expect(summary.fallbackPolicy).toBe("auto");
    expect(summary.fallbackUsed).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(
      1,
      "/runtime/bin/npm",
      [
        "list",
        "-g",
        "--depth=0",
        "--json",
        "--registry",
        "https://registry.npmmirror.com/"
      ],
      120_000,
      {}
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "/runtime/bin/npm",
      [
        "install",
        "-g",
        "openspec@1.2.3",
        "--registry",
        "https://registry.npmmirror.com/"
      ],
      120_000,
      {}
    );
  });

  it("passes a configured prefix to inventory and install commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        packages: { openspec: { version: "^1.0.0", target: "1.2.3" } }
      })
    );
    const prefix = "/tmp/npm prefix with spaces";
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "list") {
        return commandResult(command, args, { dependencies: {} });
      }

      return commandResult(command, args, {});
    });

    const summary = await syncNpmGlobals({
      runtimePath: "/runtime",
      manifestPath,
      verifyRuntime: createVerifyRuntime(),
      npmOptions: { prefix, runCommand: runner }
    });

    expect(summary.changedCount).toBe(1);
    expect(runner).toHaveBeenNthCalledWith(
      1,
      "/runtime/bin/npm",
      [
        "list",
        "-g",
        "--depth=0",
        "--json",
        "--prefix",
        prefix
      ],
      120_000,
      {}
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "/runtime/bin/npm",
      [
        "install",
        "-g",
        "openspec@1.2.3",
        "--prefix",
        prefix
      ],
      120_000,
      {}
    );
    expect(summary.actions[0].args).toEqual([
      "install",
      "-g",
      "openspec@1.2.3",
      "--prefix",
      prefix
    ]);
  });

  it("prepares a standalone prefix layout before inventory runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ packages: { openspec: { version: "^1.0.0" } } })
    );
    const prefix = join(directory, "npm prefix with spaces");
    const runner = vi.fn(async (command: string, args: string[]) =>
      commandResult(command, args, {
        dependencies: { openspec: { version: "1.1.0" } }
      })
    );

    await syncNpmGlobals({
      runtimePath: "/runtime",
      manifestPath,
      verifyRuntime: createVerifyRuntime(),
      npmOptions: { prefix, runCommand: runner }
    });

    const requiredDirectories =
      process.platform === "win32"
        ? [join(prefix, "node_modules")]
        : [join(prefix, "lib", "node_modules"), join(prefix, "bin")];

    await Promise.all(
      requiredDirectories.map(async (directoryPath) => {
        await expect(access(directoryPath)).resolves.toBeUndefined();
      })
    );
    expect(runner).toHaveBeenCalledOnce();
  });

  it("retries inventory against the official registry after a mirror failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        registryMirror: "https://registry.npmmirror.com/",
        packages: { openspec: { version: "^1.0.0" } }
      })
    );
    const prefix = "/tmp/npm-prefix";
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (
        args[0] === "list" &&
        args.includes("https://registry.npmmirror.com/")
      ) {
        throw new NpmCommandError("mirror list failed", {
          command,
          args,
          stdout: "",
          stderr: "mirror inventory error",
          exitCode: 1
        });
      }

      return commandResult(command, args, {
        dependencies: { openspec: { version: "1.1.0" } }
      });
    });

    const summary = await syncNpmGlobals({
      runtimePath: "/runtime",
      manifestPath,
      verifyRuntime: createVerifyRuntime(),
      npmOptions: { prefix, runCommand: runner }
    });

    expect(summary.noopCount).toBe(1);
    expect(summary.fallbackUsed).toBe(true);
    expect(summary.fallbackEvents).toEqual([
      {
        commandKind: "inventory",
        mirrorRegistry: "https://registry.npmmirror.com/",
        fallbackRegistry: "https://registry.npmjs.org/",
        retrySucceeded: true
      }
    ]);
    expect(runner).toHaveBeenNthCalledWith(
      1,
      "/runtime/bin/npm",
      [
        "list",
        "-g",
        "--depth=0",
        "--json",
        "--registry",
        "https://registry.npmmirror.com/",
        "--prefix",
        prefix
      ],
      120_000,
      {}
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "/runtime/bin/npm",
      [
        "list",
        "-g",
        "--depth=0",
        "--json",
        "--registry",
        "https://registry.npmjs.org/",
        "--prefix",
        prefix
      ],
      120_000,
      {}
    );
  });

  it("retries installs against the official registry after a mirror failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        registryMirror: "https://registry.npmmirror.com/",
        packages: { openspec: { version: "^1.0.0", target: "1.2.3" } }
      })
    );
    const prefix = "/tmp/npm-prefix";
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "list") {
        return commandResult(command, args, { dependencies: {} });
      }
      if (args.includes("https://registry.npmmirror.com/")) {
        throw new NpmCommandError("mirror install failed", {
          command,
          args,
          stdout: "",
          stderr: "mirror install error",
          exitCode: 1
        });
      }

      return commandResult(command, args, {});
    });

    const summary = await syncNpmGlobals({
      runtimePath: "/runtime",
      manifestPath,
      verifyRuntime: createVerifyRuntime(),
      npmOptions: { prefix, runCommand: runner }
    });

    expect(summary.changedCount).toBe(1);
    expect(summary.fallbackUsed).toBe(true);
    expect(summary.actions[0]).toMatchObject({
      packageName: "openspec",
      fallback: {
        commandKind: "install",
        packageName: "openspec",
        mirrorRegistry: "https://registry.npmmirror.com/",
        fallbackRegistry: "https://registry.npmjs.org/",
        retrySucceeded: true
      }
    });
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "/runtime/bin/npm",
      [
        "install",
        "-g",
        "openspec@1.2.3",
        "--registry",
        "https://registry.npmmirror.com/",
        "--prefix",
        prefix
      ],
      120_000,
      {}
    );
    expect(runner).toHaveBeenNthCalledWith(
      3,
      "/runtime/bin/npm",
      [
        "install",
        "-g",
        "openspec@1.2.3",
        "--registry",
        "https://registry.npmjs.org/",
        "--prefix",
        prefix
      ],
      120_000,
      {}
    );
  });

  it("disables official fallback when mirror-only mode is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        registryMirror: "https://registry.npmmirror.com/",
        packages: { openspec: { version: "^1.0.0" } }
      })
    );
    const runner = vi.fn(async (command: string, args: string[]) => {
      throw new NpmCommandError("mirror list failed", {
        command,
        args,
        stdout: "",
        stderr: "mirror-only inventory error",
        exitCode: 1
      });
    });

    await expect(
      syncNpmGlobals({
        runtimePath: "/runtime",
        manifestPath,
        fallbackPolicy: "mirror-only",
        verifyRuntime: createVerifyRuntime(),
        npmOptions: { runCommand: runner }
      })
    ).rejects.toMatchObject({
      fallbackPolicy: "mirror-only",
      fallbackAttempted: false,
      registryMirror: "https://registry.npmmirror.com/",
      mirrorContext: expect.objectContaining({
        stderr: "mirror-only inventory error"
      }),
      officialContext: undefined
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("keeps single-attempt behavior when no mirror is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ packages: { openspec: { version: "^1.0.0" } } })
    );
    const runner = vi.fn(async (command: string, args: string[]) => {
      throw new NpmCommandError("default registry list failed", {
        command,
        args,
        stdout: "",
        stderr: "default inventory error",
        exitCode: 1
      });
    });

    await expect(
      syncNpmGlobals({
        runtimePath: "/runtime",
        manifestPath,
        verifyRuntime: createVerifyRuntime(),
        npmOptions: { runCommand: runner }
      })
    ).rejects.toMatchObject({
      fallbackAttempted: false,
      registryMirror: undefined,
      stderr: "default inventory error"
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("surfaces both mirror and official failure contexts after retry exhaustion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        registryMirror: "https://registry.npmmirror.com/",
        packages: { openspec: { version: "^1.0.0" } }
      })
    );
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args.includes("https://registry.npmmirror.com/")) {
        throw new NpmCommandError("mirror list failed", {
          command,
          args,
          stdout: "mirror stdout",
          stderr: "mirror stderr",
          exitCode: 1
        });
      }

      throw new NpmCommandError("official list failed", {
        command,
        args,
        stdout: "official stdout",
        stderr: "official stderr",
        exitCode: 1
      });
    });

    await expect(
      syncNpmGlobals({
        runtimePath: "/runtime",
        manifestPath,
        verifyRuntime: createVerifyRuntime(),
        npmOptions: { runCommand: runner }
      })
    ).rejects.toMatchObject({
      fallbackPolicy: "auto",
      fallbackAttempted: true,
      registryMirror: "https://registry.npmmirror.com/",
      fallbackRegistry: "https://registry.npmjs.org/",
      stderr: "official stderr",
      mirrorContext: expect.objectContaining({
        stderr: "mirror stderr",
        stdout: "mirror stdout"
      }),
      officialContext: expect.objectContaining({
        stderr: "official stderr",
        stdout: "official stdout"
      })
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("lets CLI registry mirror options take precedence over manifest state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        registryMirror: "https://manifest.example.com/",
        packages: { openspec: { version: "^1.0.0" } }
      })
    );
    const runner = vi.fn(async (command: string, args: string[]) =>
      commandResult(command, args, { dependencies: { openspec: { version: "1.1.0" } } })
    );

    const summary = await syncNpmGlobals({
      runtimePath: "/runtime",
      manifestPath,
      registryMirror: "https://cli.example.com/",
      verifyRuntime: vi.fn(async () => ({
        valid: true,
        targetDirectory: "/runtime",
        nodePath: "/runtime/bin/node",
        npmPath: "/runtime/bin/npm",
        nodeVersion: "v22.0.0",
        npmVersion: "10.0.0"
      })),
      npmOptions: { runCommand: runner }
    });

    expect(summary.registryMirror).toBe("https://cli.example.com/");
    expect(runner.mock.calls[0][1]).toContain("https://cli.example.com/");
  });

  it("rejects invalid manifest registry mirrors before npm commands run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        registryMirror: "file:///tmp/registry",
        packages: { openspec: { version: "^1.0.0" } }
      })
    );
    const runner = vi.fn(async (command: string, args: string[]) =>
      commandResult(command, args, {})
    );

    await expect(
      syncNpmGlobals({
        runtimePath: "/runtime",
        manifestPath,
        verifyRuntime: createVerifyRuntime(),
        npmOptions: { runCommand: runner }
      })
    ).rejects.toThrow("registryMirror");
    expect(runner).not.toHaveBeenCalled();
  });

  it("wraps npm install failures with package diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-npm-sync-"));
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ packages: { openspec: { version: "^1.0.0" } } })
    );
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "list") {
        return commandResult(command, args, { dependencies: {} });
      }

      throw new NpmCommandError("failed", {
        command,
        args,
        stdout: "install stdout",
        stderr: "install stderr",
        exitCode: 1
      });
    });

    await expect(
      syncNpmGlobals({
        runtimePath: "/runtime",
        manifestPath,
        verifyRuntime: createVerifyRuntime(),
        npmOptions: { runCommand: runner }
      })
    ).rejects.toMatchObject({
      packageName: "openspec",
      stderr: "install stderr",
      stdout: "install stdout"
    });
  });
});

function commandResult(
  command: string,
  args: string[],
  json: unknown
): NpmCommandResult {
  return {
    command,
    args,
    stdout: JSON.stringify(json),
    stderr: ""
  };
}

function createVerifyRuntime() {
  return vi.fn(async () => ({
    valid: true,
    targetDirectory: "/runtime",
    nodePath: "/runtime/bin/node",
    npmPath: "/runtime/bin/npm",
    nodeVersion: "v22.0.0",
    npmVersion: "10.0.0"
  }));
}
