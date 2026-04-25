import { mkdtemp, writeFile } from "node:fs/promises";
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

  it("loads product-managed tool manifests with mandatory and selected tools", () => {
    const manifest = validateNpmSyncManifest({
      tools: {
        optionalAgentCliSyncEnabled: true,
        selectedOptionalAgentCliIds: ["codex"],
        customAgentClis: [
          { packageName: "@scope/agent-cli", version: "^2.0.0" }
        ]
      }
    });

    expect(manifest.syncMode).toBe("tools");
    expect(Object.keys(manifest.packages)).toEqual([
      "@openai/codex",
      "@scope/agent-cli",
      "code-server",
      "omniroute",
      "skills"
    ]);
    expect(manifest.packages["@openai/codex"]).toMatchObject({
      version: "*",
      target: "latest",
      toolId: "codex",
      toolGroup: "optional-agent-cli"
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
      selectedInstallSelector: "@openai/codex@latest",
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
    expect(runner).toHaveBeenCalledOnce();
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
        verifyRuntime: vi.fn(async () => ({
          valid: true,
          targetDirectory: "/runtime",
          nodePath: "/runtime/bin/node",
          npmPath: "/runtime/bin/npm",
          nodeVersion: "v22.0.0",
          npmVersion: "10.0.0"
        })),
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
