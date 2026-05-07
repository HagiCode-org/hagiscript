import { describe, expect, it, vi } from "vitest";
import {
  buildDevVersion,
  compareStableVersions,
  extractStableVersionFromTag,
  incrementPatchVersion,
  resolveDevelopmentBaseVersion,
  selectLatestPublishedReleaseVersion,
  selectNextUnreleasedReleaseVersion
} from "../../scripts/release-versioning.mjs";

describe("release versioning helpers", () => {
  it("extracts stable versions from release tags", () => {
    expect(extractStableVersionFromTag("v0.1.7")).toBe("0.1.7");
    expect(() => extractStableVersionFromTag("0.1.7")).toThrow(
      /stable vX\.Y\.Z format/
    );
  });

  it("compares stable versions numerically", () => {
    expect(compareStableVersions("0.1.7", "0.1.6")).toBeGreaterThan(0);
    expect(compareStableVersions("0.1.6", "0.2.0")).toBeLessThan(0);
    expect(compareStableVersions("0.1.6", "0.1.6")).toBe(0);
  });

  it("selects the highest draft version above the latest published release", () => {
    expect(
      selectNextUnreleasedReleaseVersion([
        { tag_name: "v0.1.6", draft: false, prerelease: false },
        { tag_name: "v0.1.7", draft: true, prerelease: false },
        { tag_name: "v0.2.0", draft: true, prerelease: false },
        { tag_name: "v0.1.5", draft: true, prerelease: false },
        { tag_name: "nightly", draft: true, prerelease: false }
      ])
    ).toBe("0.2.0");
  });

  it("selects the latest published version and increments patch when no draft exists", () => {
    expect(
      selectLatestPublishedReleaseVersion([
        { tag_name: "v0.1.9", draft: false, prerelease: false },
        { tag_name: "v0.1.8", draft: false, prerelease: false },
        { tag_name: "v0.2.0-rc.1", draft: false, prerelease: true }
      ])
    ).toBe("0.1.9");
    expect(incrementPatchVersion("0.1.9")).toBe("0.1.10");
  });

  it("resolves the development base version from the unreleased draft tag", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { tag_name: "v0.1.6", draft: false, prerelease: false },
          { tag_name: "v0.1.7", draft: true, prerelease: false }
        ]),
        { status: 200 }
      )
    );

    await expect(
      resolveDevelopmentBaseVersion({
        packageVersion: "0.1.6",
        repository: "HagiCode-org/hagiscript",
        githubToken: "token",
        fetchImpl
      })
    ).resolves.toBe("0.1.7");
  });

  it("falls back to package version outside the release-aware workflow", async () => {
    await expect(
      resolveDevelopmentBaseVersion({
        packageVersion: "0.1.6"
      })
    ).resolves.toBe("0.1.6");
  });

  it("fails when unreleased release tags are required but unavailable", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 })
    );

    await expect(
      resolveDevelopmentBaseVersion({
        packageVersion: "0.1.6",
        repository: "HagiCode-org/hagiscript",
        githubToken: "token",
        fetchImpl,
        requireUnreleasedTag: true
      })
    ).rejects.toThrow(/Unable to resolve a development base version/);
  });

  it("uses the next patch after the latest published tag when no unreleased draft exists", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { tag_name: "v0.1.9", draft: false, prerelease: false },
          { tag_name: "v0.1.8", draft: false, prerelease: false }
        ]),
        { status: 200 }
      )
    );

    await expect(
      resolveDevelopmentBaseVersion({
        packageVersion: "0.1.6",
        repository: "HagiCode-org/hagiscript",
        githubToken: "token",
        fetchImpl
      })
    ).resolves.toBe("0.1.10");
  });

  it("builds dev versions from the resolved base version", () => {
    expect(
      buildDevVersion("0.1.7", {
        GITHUB_RUN_NUMBER: "12",
        GITHUB_RUN_ATTEMPT: "3",
        GITHUB_SHA: "abcdef123456"
      })
    ).toBe("0.1.7-dev.12.3.abcdef1");
  });
});
