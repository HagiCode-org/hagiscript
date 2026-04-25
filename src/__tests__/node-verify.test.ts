import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeExecutablePaths,
  verifyNodeRuntime
} from "../runtime/node-verify.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = join(
    tmpdir(),
    `hagiscript-verify-${Date.now()}-${Math.random()}`
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

describe("Node.js runtime verification", () => {
  it("discovers Unix-style node and npm executables", () => {
    expect(getRuntimeExecutablePaths("/runtime", "linux")).toEqual({
      nodePath: "/runtime/bin/node",
      npmPath: "/runtime/bin/npm"
    });
  });

  it("discovers Windows node.exe and npm.cmd executables", () => {
    expect(getRuntimeExecutablePaths("C:/runtime", "win32")).toEqual({
      nodePath: join("C:/runtime", "node.exe"),
      npmPath: join("C:/runtime", "npm.cmd")
    });
  });

  it("returns structured success results", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "node"), "#!/bin/sh\n");
    await writeFile(join(root, "bin", "npm"), "#!/bin/sh\n");
    await chmod(join(root, "bin", "node"), 0o755);
    await chmod(join(root, "bin", "npm"), 0o755);

    const result = await verifyNodeRuntime(root, {
      platform: "linux",
      runCommand: async (command) =>
        command.endsWith("node") ? "v22.12.0\n" : "10.9.0\n"
    });

    expect(result).toMatchObject({
      valid: true,
      nodeVersion: "v22.12.0",
      npmVersion: "10.9.0"
    });
  });

  it("returns structured failure results when executables are missing", async () => {
    const root = await makeTempRoot();

    const result = await verifyNodeRuntime(root, { platform: "linux" });

    expect(result.valid).toBe(false);
    expect(result.failureReason).toContain("access");
  });
});
