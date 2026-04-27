import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
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

  it("falls back to Node-based tar extraction after external tar fails", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "fixture.tar.xz");
    const staging = join(root, "staging");
    await writeFile(archive, gzipSync(createSingleFileTar("node-root/bin/node", "node")));

    const extractedRoot = await extractNodeArchive(archive, staging, "tar.xz", {
      runCommand: async () => {
        throw new Error("external tar unavailable");
      }
    });

    expect(extractedRoot).toBe(join(staging, "node-root"));
    await expect(readdir(join(extractedRoot, "bin"))).resolves.toEqual(["node"]);
  });
});

function createSingleFileTar(fileName: string, contents: string): Buffer {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512, 0);
  header.write(fileName, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(" ", 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length, 0);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024, 0)]);
}
