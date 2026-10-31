import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { findHostNode, listHostNodeCandidates } from "../runtime/host-node.js";

async function createExecutable(
  directory: string,
  name: string,
  mode = 0o755
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await writeFile(filePath, "");
  await chmod(filePath, mode);
  return filePath;
}

describe("listHostNodeCandidates", () => {
  it("lists absolute POSIX PATH entries in order and skips empty and relative entries", () => {
    expect(
      listHostNodeCandidates({
        pathEnv: "/usr/local/bin::relative/bin:/usr/bin",
        platform: "linux"
      })
    ).toEqual(["/usr/local/bin/node", "/usr/bin/node"]);
  });

  it("uses node.exe on Windows and splits on semicolons", () => {
    expect(
      listHostNodeCandidates({
        pathEnv: "C:\\Program Files\\nodejs;C:\\Tools",
        platform: "win32"
      })
    ).toEqual([
      path.win32.join("C:\\Program Files\\nodejs", "node.exe"),
      path.win32.join("C:\\Tools", "node.exe")
    ]);
  });

  it("never returns a .cmd shim on Windows", () => {
    const candidates = listHostNodeCandidates({
      pathEnv: "C:\\Program Files\\nodejs",
      platform: "win32"
    });

    expect(
      candidates.every((candidate) => candidate.endsWith("node.exe"))
    ).toBe(true);
    expect(candidates.some((candidate) => candidate.endsWith(".cmd"))).toBe(
      false
    );
  });

  it("accepts quoted Windows PATH entries", () => {
    expect(
      listHostNodeCandidates({
        pathEnv: '"C:\\Program Files\\nodejs"',
        platform: "win32"
      })
    ).toEqual([path.win32.join("C:\\Program Files\\nodejs", "node.exe")]);
  });
});

describe("findHostNode", () => {
  it.skipIf(process.platform === "win32")(
    "returns the first executable node on PATH",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "hagiscript-host-node-")
      );
      try {
        const firstDirectory = path.join(directory, "first");
        const secondDirectory = path.join(directory, "second");
        await mkdir(firstDirectory, { recursive: true });
        const secondNode = await createExecutable(secondDirectory, "node");

        await expect(
          findHostNode({
            pathEnv: `${firstDirectory}:${secondDirectory}`,
            platform: "linux"
          })
        ).resolves.toBe(secondNode);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "ignores a node file that is not executable",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "hagiscript-host-node-")
      );
      try {
        await createExecutable(directory, "node", 0o644);

        await expect(
          findHostNode({ pathEnv: directory, platform: "linux" })
        ).resolves.toBeUndefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "skips PATH entries that do not exist",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "hagiscript-host-node-")
      );
      try {
        const existingNode = await createExecutable(
          path.join(directory, "bin"),
          "node"
        );

        await expect(
          findHostNode({
            pathEnv: `${path.join(directory, "missing")}:${path.join(directory, "bin")}`,
            platform: "linux"
          })
        ).resolves.toBe(existingNode);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("returns undefined for an empty PATH", async () => {
    await expect(
      findHostNode({ pathEnv: "", platform: "linux" })
    ).resolves.toBeUndefined();
  });

  it("returns undefined when a PATH entry is a directory named node", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "hagiscript-host-node-")
    );
    try {
      await mkdir(path.join(directory, "node"), { recursive: true });

      await expect(
        findHostNode({ pathEnv: directory, platform: "linux" })
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "finds node.exe on Windows and ignores node.cmd",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "hagiscript-host-node-win-")
      );
      try {
        await writeFile(path.join(directory, "node.cmd"), "");
        const windowsNode = await createExecutable(
          path.join(directory, "bin"),
          "node.exe"
        );

        await expect(
          findHostNode({
            pathEnv: `${directory};${path.join(directory, "bin")}`,
            platform: "win32"
          })
        ).resolves.toBe(windowsNode);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
