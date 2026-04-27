import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
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
    const paths = getRuntimeExecutablePaths("/runtime", "linux");

    expect(paths).toEqual({
      nodePath: join("/runtime", "bin", "node"),
      npmPath: join("/runtime", "bin", "npm")
    });
    expect(paths.nodePath.split("\\").join("/")).toBe(
      posix.join("/runtime", "bin", "node")
    );
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

  it("checks versions through the default command runner", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "node"), "#!/bin/sh\necho v22.12.0\n");
    await writeFile(join(root, "bin", "npm"), "#!/bin/sh\necho 10.9.0\n");
    await chmod(join(root, "bin", "node"), 0o755);
    await chmod(join(root, "bin", "npm"), 0o755);

    const result = await verifyNodeRuntime(root, { platform: "linux" });

    expect(result).toMatchObject({
      valid: true,
      nodeVersion: "v22.12.0",
      npmVersion: "10.9.0"
    });
  });

  it("returns invalid results when default command execution fails", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(
      join(root, "bin", "node"),
      "#!/bin/sh\necho node failed >&2\nexit 2\n"
    );
    await writeFile(join(root, "bin", "npm"), "#!/bin/sh\necho 10.9.0\n");
    await chmod(join(root, "bin", "node"), 0o755);
    await chmod(join(root, "bin", "npm"), 0o755);

    const result = await verifyNodeRuntime(root, { platform: "linux" });

    expect(result.valid).toBe(false);
    expect(result.failureReason).toContain("node failed");
  });

  it("uses shell launch options for Windows npm.cmd verification only", async () => {
    const root = await makeTempRoot();
    await writeFile(join(root, "node.exe"), "");
    await writeFile(join(root, "npm.cmd"), "");
    await chmod(join(root, "node.exe"), 0o755);
    await chmod(join(root, "npm.cmd"), 0o755);
    const calls: Array<{
      command: string;
      args: string[];
      timeoutMs: number;
      launchOptions?: { shell?: boolean };
    }> = [];

    const result = await verifyNodeRuntime(root, {
      platform: "win32",
      runCommand: async (command, args, timeoutMs, launchOptions) => {
        calls.push({ command, args, timeoutMs, launchOptions });
        return command.endsWith("node.exe") ? "v22.12.0\n" : "10.9.0\n";
      }
    });

    expect(result).toMatchObject({ valid: true, npmVersion: "10.9.0" });
    expect(calls).toEqual([
      {
        command: join(root, "node.exe"),
        args: ["--version"],
        timeoutMs: 15_000,
        launchOptions: {}
      },
      {
        command: join(root, "npm.cmd"),
        args: ["--version"],
        timeoutMs: 15_000,
        launchOptions: { shell: true }
      }
    ]);
  });

  it("keeps POSIX npm verification on direct execution", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "node"), "#!/bin/sh\n");
    await writeFile(join(root, "bin", "npm"), "#!/bin/sh\n");
    await chmod(join(root, "bin", "node"), 0o755);
    await chmod(join(root, "bin", "npm"), 0o755);
    const calls: Array<{
      command: string;
      launchOptions?: { shell?: boolean };
    }> = [];

    await verifyNodeRuntime(root, {
      platform: "linux",
      runCommand: async (command, _args, _timeoutMs, launchOptions) => {
        calls.push({ command, launchOptions });
        return command.endsWith("node") ? "v22.12.0\n" : "10.9.0\n";
      }
    });

    expect(calls).toEqual([
      { command: join(root, "bin", "node"), launchOptions: {} },
      { command: join(root, "bin", "npm"), launchOptions: {} }
    ]);
  });

  it("returns structured failure results when executables are missing", async () => {
    const root = await makeTempRoot();

    const result = await verifyNodeRuntime(root, { platform: "linux" });

    expect(result.valid).toBe(false);
    expect(result.failureReason).toContain("access");
  });
});
