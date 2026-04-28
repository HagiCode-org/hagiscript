import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInstallGlobalPackageArgs,
  buildListGlobalPackagesArgs,
  installGlobalPackage,
  listGlobalPackages,
  NpmCommandError
} from "../runtime/npm-global.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = join(
    tmpdir(),
    `hagiscript-npm-${Date.now()}-${Math.random()}`
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

describe("npm global wrappers", () => {
  it("builds list and install arguments with a configured prefix", () => {
    expect(
      buildListGlobalPackagesArgs({ prefix: "/tmp/npm prefix with spaces" })
    ).toEqual([
      "list",
      "-g",
      "--depth=0",
      "--json",
      "--prefix",
      "/tmp/npm prefix with spaces"
    ]);
    expect(
      buildInstallGlobalPackageArgs("openspec@^1.0.0", {
        prefix: "/tmp/npm-prefix"
      })
    ).toEqual([
      "install",
      "-g",
      "openspec@^1.0.0",
      "--prefix",
      "/tmp/npm-prefix"
    ]);
  });

  it("composes registry mirror and prefix arguments deterministically", () => {
    expect(
      buildListGlobalPackagesArgs({
        registryMirror: "https://registry.example.test",
        prefix: "/tmp/npm-prefix"
      })
    ).toEqual([
      "list",
      "-g",
      "--depth=0",
      "--json",
      "--registry",
      "https://registry.example.test",
      "--prefix",
      "/tmp/npm-prefix"
    ]);
    expect(
      buildInstallGlobalPackageArgs("openspec@^1.0.0", {
        registryMirror: "https://registry.example.test",
        prefix: "/tmp/npm-prefix"
      })
    ).toEqual([
      "install",
      "-g",
      "openspec@^1.0.0",
      "--registry",
      "https://registry.example.test",
      "--prefix",
      "/tmp/npm-prefix"
    ]);
  });

  it("lists global package inventory with the target npm executable", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => ({
      command,
      args,
      stdout: "{}",
      stderr: ""
    }));

    await listGlobalPackages("/runtime/bin/npm", { runCommand: runner });

    expect(runner).toHaveBeenCalledWith(
      "/runtime/bin/npm",
      ["list", "-g", "--depth=0", "--json"],
      120_000,
      {}
    );
  });

  it("lists Windows npm.cmd inventory on direct execution", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => ({
      command,
      args,
      stdout: "{}",
      stderr: ""
    }));

    await listGlobalPackages("C:/runtime/npm.cmd", {
      platform: "win32",
      runCommand: runner
    });

    expect(runner).toHaveBeenCalledWith(
      "C:/runtime/npm.cmd",
      ["list", "-g", "--depth=0", "--json"],
      120_000,
      {}
    );
  });

  it("surfaces failed inventory subprocess calls", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => {
      throw new NpmCommandError("failed", {
        command,
        args,
        stdout: "",
        stderr: "list failed",
        exitCode: 1
      });
    });

    await expect(
      listGlobalPackages("/runtime/bin/npm", { runCommand: runner })
    ).rejects.toMatchObject({ context: { stderr: "list failed" } });
  });

  it("installs global packages with selected package selectors", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => ({
      command,
      args,
      stdout: "installed",
      stderr: ""
    }));

    const result = await installGlobalPackage(
      "/runtime/bin/npm",
      "openspec@^1.0.0",
      {
        runCommand: runner
      }
    );

    expect(result.stdout).toBe("installed");
    expect(runner).toHaveBeenCalledWith(
      "/runtime/bin/npm",
      ["install", "-g", "openspec@^1.0.0"],
      120_000,
      {}
    );
  });

  it("installs through Windows npm.cmd directly with registry mirrors", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => ({
      command,
      args,
      stdout: "installed",
      stderr: ""
    }));

    await installGlobalPackage("C:/runtime/npm.cmd", "openspec@^1.0.0", {
      platform: "win32",
      registryMirror: "https://registry.example.test",
      runCommand: runner
    });

    expect(runner).toHaveBeenCalledWith(
      "C:/runtime/npm.cmd",
      [
        "install",
        "-g",
        "openspec@^1.0.0",
        "--registry",
        "https://registry.example.test"
      ],
      120_000,
      {}
    );
  });

  it("keeps POSIX npm global commands on direct execution", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => ({
      command,
      args,
      stdout: "{}",
      stderr: ""
    }));

    await listGlobalPackages("/runtime/bin/npm", {
      platform: "linux",
      runCommand: runner
    });

    expect(runner).toHaveBeenCalledWith(
      "/runtime/bin/npm",
      ["list", "-g", "--depth=0", "--json"],
      120_000,
      {}
    );
  });

  it("surfaces failed install subprocess calls", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => {
      throw new NpmCommandError("failed", {
        command,
        args,
        stdout: "install output",
        stderr: "install failed",
        exitCode: 1
      });
    });

    await expect(
      installGlobalPackage("/runtime/bin/npm", "openspec@^1.0.0", {
        runCommand: runner
      })
    ).rejects.toMatchObject({
      context: { stdout: "install output", stderr: "install failed" }
    });
  });

  it("uses the default command runner when no runner is injected", async () => {
    const root = await makeTempRoot();
    const npmPath = join(root, "npm");
    await writeFile(
      npmPath,
      "#!/bin/sh\nprintf '{\"dependencies\":{}}'\nprintf 'default-runner' >&2\n"
    );
    await chmod(npmPath, 0o755);

    const result = await listGlobalPackages(npmPath, { platform: "linux" });

    expect(result).toMatchObject({
      command: npmPath,
      args: ["list", "-g", "--depth=0", "--json"],
      stdout: '{"dependencies":{}}',
      stderr: "default-runner"
    });
  });
});
