import { describe, expect, it } from "vitest";
import {
  requiresBootstrapShell,
  runProcess
} from "../../scripts/process-runner.mjs";

describe("process runner", () => {
  it("preserves argument boundaries for direct process execution", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "npm-sync",
      "--prefix",
      "/tmp/npm prefix with spaces"
    ]);

    expect(JSON.parse(result.stdout)).toEqual([
      "npm-sync",
      "--prefix",
      "/tmp/npm prefix with spaces"
    ]);
  });

  it("does not inject cmd.exe wrapper text into failure messages", async () => {
    await expect(
      runProcess("/definitely/missing/command")
    ).rejects.toThrow("/definitely/missing/command");
  });

  it("falls back to the bootstrap runner when execa is disabled", async () => {
    process.env.HAGISCRIPT_DISABLE_EXECA = "1";

    try {
      const result = await runProcess(process.execPath, [
        "-e",
        "process.stdout.write('bootstrap-ok')"
      ]);

      expect(result.stdout).toBe("bootstrap-ok");
    } finally {
      delete process.env.HAGISCRIPT_DISABLE_EXECA;
    }
  });

  it("times out long-running processes", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
        timeoutMs: 250
      })
    ).rejects.toThrow("Command timed out");
  });

  it("only enables the bootstrap shell wrapper for Windows command shims", () => {
    expect(requiresBootstrapShell("npm.cmd", "win32")).toBe(true);
    expect(
      requiresBootstrapShell('"C:/Program Files/node/npm.cmd"', "win32")
    ).toBe(true);
    expect(requiresBootstrapShell("C:/runtime/node.exe", "win32")).toBe(false);
    expect(requiresBootstrapShell("/runtime/bin/npm", "linux")).toBe(false);
  });
});
