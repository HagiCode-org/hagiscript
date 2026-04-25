import { describe, expect, it } from "vitest";
import {
  mapNodePlatform,
  UnsupportedNodePlatformError
} from "../runtime/node-platform.js";
import {
  NodeRuntimeSourcePolicyError,
  NodeVersionSelectorError,
  resolveNodeRelease,
  selectNodeArchive,
  validateVersionSelector,
  type NodeReleaseMetadata
} from "../runtime/node-release.js";

const releases: NodeReleaseMetadata[] = [
  { version: "v23.3.0", files: ["linux-x64", "win-x64", "darwin-arm64"] },
  {
    version: "v22.12.0",
    files: ["linux-x64", "linux-arm64", "win-x64", "darwin-arm64"],
    lts: "Jod"
  },
  { version: "v22.1.0", files: ["linux-x64"] },
  { version: "v20.18.1", files: ["linux-x64", "win-x64"], lts: "Iron" }
];

describe("Node.js release resolution", () => {
  it("defaults omitted selectors to the latest Node.js 22 release", () => {
    expect(resolveNodeRelease(releases).version).toBe("v22.12.0");
  });

  it("resolves lts, latest/current, exact versions, and major selectors", () => {
    expect(resolveNodeRelease(releases, "lts").version).toBe("v22.12.0");
    expect(resolveNodeRelease(releases, "latest").version).toBe("v23.3.0");
    expect(resolveNodeRelease(releases, "current").version).toBe("v23.3.0");
    expect(resolveNodeRelease(releases, "20").version).toBe("v20.18.1");
    expect(resolveNodeRelease(releases, "22.1.0").version).toBe("v22.1.0");
    expect(resolveNodeRelease(releases, "v20.18.1").version).toBe("v20.18.1");
  });

  it("rejects unavailable versions and malformed selectors", () => {
    expect(() => resolveNodeRelease(releases, "19")).toThrow(
      NodeVersionSelectorError
    );
    expect(() => validateVersionSelector("twenty-two")).toThrow(
      NodeVersionSelectorError
    );
    expect(() => validateVersionSelector("22.1")).toThrow(
      NodeVersionSelectorError
    );
  });

  it("selects official archive URLs for supported platform files", () => {
    const selected = selectNodeArchive(
      releases,
      "22",
      mapNodePlatform("linux", "x64")
    );

    expect(selected.fileName).toBe("node-v22.12.0-linux-x64.tar.xz");
    expect(selected.url).toBe(
      "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz"
    );
  });

  it("rejects non-official distribution sources", () => {
    expect(() =>
      selectNodeArchive(
        releases,
        "22",
        mapNodePlatform("linux", "x64"),
        "https://example.test/dist"
      )
    ).toThrow(NodeRuntimeSourcePolicyError);
  });
});

describe("Node.js platform mapping", () => {
  it("maps Windows, Linux, and macOS x64/arm64 archive names", () => {
    expect(mapNodePlatform("win32", "x64")).toMatchObject({
      nodeFileKey: "win-x64",
      archiveExtension: "zip"
    });
    expect(mapNodePlatform("linux", "arm64")).toMatchObject({
      nodeFileKey: "linux-arm64",
      archiveExtension: "tar.xz"
    });
    expect(mapNodePlatform("darwin", "arm64")).toMatchObject({
      nodeFileKey: "darwin-arm64",
      archiveExtension: "tar.xz"
    });
  });

  it("rejects unsupported operating systems and CPU architectures", () => {
    expect(() => mapNodePlatform("freebsd", "x64")).toThrow(
      UnsupportedNodePlatformError
    );
    expect(() => mapNodePlatform("linux", "ia32")).toThrow(
      UnsupportedNodePlatformError
    );
  });
});
