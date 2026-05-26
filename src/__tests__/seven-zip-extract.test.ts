import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBundledSevenZipExtractor,
  getBundledSevenZipBinaryPath
} from "../runtime/seven-zip-extract.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("bundled 7z extraction", () => {
  it("uses the bundled extractor binary instead of a host PATH lookup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hagiscript-seven-zip-"));
    tempRoots.push(root);
    const runner = vi.fn(async () => ({
      command: "/bundled/7za",
      args: [],
      stdout: "",
      stderr: ""
    }));
    const extractor = createBundledSevenZipExtractor({
      binaryPath: "/bundled/7za",
      runner
    });

    await extractor.extract(
      path.join(root, "fixture.7z"),
      path.join(root, "extract")
    );

    expect(runner).toHaveBeenCalledWith(
      "/bundled/7za",
      [
        "x",
        "-bd",
        "-y",
        `-o${path.join(root, "extract")}`,
        path.join(root, "fixture.7z")
      ],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 })
    );
  });

  it("returns a deterministic bundled extractor path", () => {
    expect(getBundledSevenZipBinaryPath()).toContain("7zip-bin");
  });

  it("restores execute permissions before invoking the bundled extractor on POSIX hosts", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(
      path.join(tmpdir(), "hagiscript-seven-zip-mode-")
    );
    tempRoots.push(root);
    const binaryPath = path.join(root, "7za");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const runner = vi.fn(async () => ({
      command: binaryPath,
      args: [],
      stdout: "",
      stderr: ""
    }));
    const extractor = createBundledSevenZipExtractor({
      binaryPath,
      runner
    });

    await extractor.extract(
      path.join(root, "fixture.7z"),
      path.join(root, "extract")
    );

    expect(runner).toHaveBeenCalledOnce();
    expect((await stat(binaryPath)).mode & 0o111).toBe(0o111);
    await expect(readFile(binaryPath, "utf8")).resolves.toContain("#!/bin/sh");
  });

  it("reports actionable bundled extraction failures", async () => {
    const extractor = createBundledSevenZipExtractor({
      binaryPath: "/bundled/7za",
      runner: vi.fn(async () => {
        throw new Error("permission denied");
      })
    });

    await expect(
      extractor.extract("/tmp/archive.7z", "/tmp/extract")
    ).rejects.toThrow(
      "Failed to extract 7z archive /tmp/archive.7z with bundled provider /bundled/7za: permission denied"
    );
  });
});
