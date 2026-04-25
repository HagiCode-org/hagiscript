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
      "qoder",
      "opencode"
    ]);
    expect(catalog.filter((entry) => entry.requirement === "mandatory")).toHaveLength(3);
    expect(catalog.filter((entry) => entry.group === "optional-agent-cli")).toHaveLength(3);
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

  it("rejects enabled optional CLI sync with zero selections", () => {
    expect(() =>
      buildToolSyncPackageSet({ optionalAgentCliSyncEnabled: true })
    ).toThrow("at least one optional agent CLI must be selected");
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
      toolId: "custom:@scope/agent-cli"
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
