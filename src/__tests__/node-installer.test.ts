import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installNodeRuntime } from "../runtime/node-installer.js";
import { mapNodePlatform } from "../runtime/node-platform.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = join(
    tmpdir(),
    `hagiscript-install-${Date.now()}-${Math.random()}`
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

describe("Node.js runtime installer", () => {
  it("installs from mocked metadata and a local fixture archive", async () => {
    const platform = mapNodePlatform();
    if (platform.archiveExtension !== "tar.xz") {
      return;
    }

    const root = await makeTempRoot();
    const archivePath = await createUnixFixtureArchive(
      root,
      platform.nodeFileKey
    );
    const archiveBytes = await import("node:fs/promises").then(({ readFile }) =>
      readFile(archivePath)
    );
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/index.json")) {
        return Response.json([
          {
            version: "v22.12.0",
            files: [platform.nodeFileKey],
            npm: "10.9.0",
            lts: "Jod"
          }
        ]);
      }

      return new Response(archiveBytes, {
        status: 200,
        headers: { "content-length": String(archiveBytes.byteLength) }
      });
    }) as unknown as typeof fetch;

    const targetDirectory = join(root, "node-runtime");
    const result = await installNodeRuntime({ targetDirectory, fetchImpl });

    expect(result).toMatchObject({
      version: "v22.12.0",
      npmVersion: "10.9.0",
      targetDirectory,
      nodePath: join(targetDirectory, "bin", "node"),
      npmPath: join(targetDirectory, "bin", "npm")
    });
    const rootEntries = await readdir(root);
    expect(rootEntries).not.toContainEqual(
      expect.stringMatching(/^\.hagiscript-node-/)
    );
  });
});

async function createUnixFixtureArchive(
  root: string,
  nodeFileKey: string
): Promise<string> {
  const source = join(root, "source");
  const runtimeRoot = join(source, `node-v22.12.0-${nodeFileKey}`);
  const bin = join(runtimeRoot, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "node"), "#!/bin/sh\necho v22.12.0\n");
  await writeFile(join(bin, "npm"), "#!/bin/sh\necho 10.9.0\n");
  await chmod(join(bin, "node"), 0o755);
  await chmod(join(bin, "npm"), 0o755);

  const archivePath = join(root, `node-v22.12.0-${nodeFileKey}.tar.xz`);
  await execFileAsync("tar", [
    "-cJf",
    archivePath,
    "-C",
    source,
    `node-v22.12.0-${nodeFileKey}`
  ]);

  return archivePath;
}
