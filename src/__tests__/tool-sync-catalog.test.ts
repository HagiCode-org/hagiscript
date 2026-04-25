import { describe, expect, it } from "vitest";
import {
  buildToolSyncPackageSet,
  builtInToolSyncCatalog,
  validateToolSyncCatalog
} from "../runtime/tool-sync-catalog.js";

describe("tool sync catalog", () => {
  it("exposes mandatory and optional groups with stable tool IDs", () => {
    const catalog = validateToolSyncCatalog(builtInToolSyncCatalog);

    expect(catalog.map((entry) => entry.id)).toEqual([
      "openspec-skills",
      "omniroute",
      "code-server",
      "codex",
      "claude-code",
      "fission-openspec",
      "qoder",
      "opencode"
    ]);
    expect(catalog.filter((entry) => entry.requirement === "mandatory")).toHaveLength(3);
    expect(catalog.filter((entry) => entry.group === "optional-agent-cli")).toHaveLength(5);
  });

  it("loads pinned package versions from the internal catalog config", () => {
    expect(
      Object.fromEntries(
        builtInToolSyncCatalog.map((entry) => [entry.id, entry.target])
      )
    ).toEqual({
      "openspec-skills": "1.5.1",
      omniroute: "3.6.9",
      "code-server": "4.117.0",
      codex: "0.125.0",
      "claude-code": "2.1.119",
      "fission-openspec": "1.3.1",
      qoder: "0.1.48",
      opencode: "1.14.24"
    });
  });

  it("always includes mandatory tools without user selection", () => {
    expect(Object.keys(buildToolSyncPackageSet())).toEqual([
      "code-server",
      "omniroute",
      "skills"
    ]);
  });

  it("includes selected optional agent CLIs with mandatory tools", () => {
    const packages = buildToolSyncPackageSet({
      optionalAgentCliSyncEnabled: true,
      selectedOptionalAgentCliIds: ["codex"]
    });

    expect(packages["@openai/codex"]).toMatchObject({
      toolId: "codex",
      toolGroup: "optional-agent-cli"
    });
    expect(packages.skills.toolRequirement).toBe("mandatory");
  });

  it("includes Claude Code and Fission OpenSpec when selected", () => {
    const packages = buildToolSyncPackageSet({
      optionalAgentCliSyncEnabled: true,
      selectedOptionalAgentCliIds: ["claude-code", "fission-openspec"]
    });

    expect(packages["@anthropic-ai/claude-code"]).toMatchObject({
      version: "2.1.119",
      target: "2.1.119",
      toolId: "claude-code"
    });
    expect(packages["@fission-ai/openspec"]).toMatchObject({
      version: "1.3.1",
      target: "1.3.1",
      toolId: "fission-openspec"
    });
  });

  it("allows enabled optional CLI sync with zero selections", () => {
    expect(
      Object.keys(buildToolSyncPackageSet({ optionalAgentCliSyncEnabled: true }))
    ).toEqual(["code-server", "omniroute", "skills"]);
  });

  it("rejects unknown optional CLI IDs", () => {
    expect(() =>
      buildToolSyncPackageSet({
        optionalAgentCliSyncEnabled: true,
        selectedOptionalAgentCliIds: ["unknown-cli"]
      })
    ).toThrow("unknown optional agent CLI tool ID: unknown-cli");
  });

  it("normalizes valid custom npm agent CLIs", () => {
    const packages = buildToolSyncPackageSet({
      optionalAgentCliSyncEnabled: true,
      customAgentClis: [
        {
          packageName: "@scope/agent-cli",
          version: "^1.0.0"
        }
      ]
    });

    expect(packages["@scope/agent-cli"]).toMatchObject({
      version: "^1.0.0",
      target: "^1.0.0",
      toolId: "custom:scope-agent-cli"
    });
  });

  it("rejects invalid custom npm agent CLIs", () => {
    expect(() =>
      buildToolSyncPackageSet({
        optionalAgentCliSyncEnabled: true,
        customAgentClis: [{ packageName: "bad package", version: "latest" }]
      })
    ).toThrow("packageName is invalid");
  });
});
