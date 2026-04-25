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
      120_000
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
      120_000
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
