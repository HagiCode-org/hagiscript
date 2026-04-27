import { describe, expect, it, vi } from "vitest";
import {
  installGlobalPackage,
  listGlobalPackages,
  NpmCommandError
} from "../runtime/npm-global.js";

describe("npm global wrappers", () => {
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

  it("lists Windows npm.cmd inventory with shell launch options", async () => {
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
      { shell: true }
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

  it("installs through Windows npm.cmd with shell launch options and registry mirrors", async () => {
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
      { shell: true }
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
});
