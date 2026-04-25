import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadNodeArchive,
  NodeRuntimeNetworkError
} from "../runtime/node-download.js";
import {
  assertTargetIsEmptyOrMissing,
  extractNodeArchive,
  NodeRuntimeExtractionError
} from "../runtime/node-extract.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = join(
    tmpdir(),
    `hagiscript-runtime-${Date.now()}-${Math.random()}`
  );
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("Node.js archive download", () => {
  it("streams downloads with progress", async () => {
    const root = await makeTempRoot();
    const destination = join(root, "node.tar.xz");
    const onProgress = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Blob(["runtime"]), {
          status: 200,
          headers: { "content-length": "7" }
        })
    ) as unknown as typeof fetch;

    await downloadNodeArchive(
      "https://nodejs.org/dist/v22.0.0/node.tar.xz",
      destination,
      {
        fetchImpl,
        onProgress
      }
    );

    expect(onProgress).toHaveBeenCalledWith({
      receivedBytes: 7,
      totalBytes: 7
    });
  });

  it("classifies HTTP failures as network errors", async () => {
    const root = await makeTempRoot();
    const fetchImpl = vi.fn(
      async () => new Response("missing", { status: 404 })
    ) as unknown as typeof fetch;

    await expect(
      downloadNodeArchive(
        "https://nodejs.org/dist/missing",
        join(root, "node.tar.xz"),
        { fetchImpl }
      )
    ).rejects.toThrow(NodeRuntimeNetworkError);
  });
});

describe("Node.js extraction guards", () => {
  it("rejects non-empty target directories", async () => {
    const root = await makeTempRoot();
    await writeFile(join(root, "keep.txt"), "do not delete");

    await expect(assertTargetIsEmptyOrMissing(root)).rejects.toThrow(
      NodeRuntimeExtractionError
    );
  });

  it("rejects corrupt archives", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "corrupt.tar.xz");
    const staging = join(root, "staging");
    await writeFile(archive, "not an archive");

    await expect(
      extractNodeArchive(archive, staging, "tar.xz")
    ).rejects.toThrow(NodeRuntimeExtractionError);
    await expect(readdir(staging)).resolves.toEqual([]);
  });
});
