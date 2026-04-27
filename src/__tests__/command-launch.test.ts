import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandExecutionError,
  getCommandLaunchOptions,
  normalizeCommandPath,
  requiresShellLaunch,
  runCommand
} from "../runtime/command-launch.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = join(
    tmpdir(),
    `hagiscript-command-${Date.now()}-${Math.random()}`
  );
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("command runner", () => {
  it("captures stdout, stderr, and command metadata", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err')"
    ]);

    expect(result).toMatchObject({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      stdout: "out",
      stderr: "err",
      exitCode: 0,
      timedOut: false
    });
    expect(result.cwd).toBeTruthy();
  });

  it("passes cwd, env, timeout, and preserves argument boundaries", async () => {
    const root = await makeTempRoot();
    const scriptPath = join(root, "print args.js");
    await writeFile(
      scriptPath,
      "process.stdout.write(JSON.stringify({cwd: process.cwd(), value: process.env.HAGISCRIPT_TEST_VALUE, args: process.argv.slice(2)}));"
    );

    const result = await runCommand(
      process.execPath,
      [scriptPath, "two words", 'quoted "value"'],
      {
        cwd: root,
        env: { HAGISCRIPT_TEST_VALUE: "from-env" },
        timeoutMs: 5_000
      }
    );

    expect(JSON.parse(result.stdout)).toEqual({
      cwd: root,
      value: "from-env",
      args: ["two words", 'quoted "value"']
    });
  });

  it("normalizes non-zero exit failures with stderr and exit code", async () => {
    await expect(
      runCommand(process.execPath, [
        "-e",
        "process.stdout.write('partial'); process.stderr.write('boom'); process.exit(7)"
      ])
    ).rejects.toMatchObject({
      context: {
        command: process.execPath,
        stdout: "partial",
        stderr: "boom",
        exitCode: 7,
        timedOut: false,
        failed: true
      }
    });
  });

  it("normalizes timeout failures", async () => {
    try {
      await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
        timeoutMs: 50
      });
      throw new Error("Expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandExecutionError);
      expect((error as CommandExecutionError).context).toMatchObject({
        command: process.execPath,
        timedOut: true,
        failed: true
      });
    }
  });

  it("normalizes signal failures when the child terminates itself", async () => {
    try {
      await runCommand(process.execPath, [
        "-e",
        "process.kill(process.pid, 'SIGTERM')"
      ]);
      throw new Error("Expected signal termination");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandExecutionError);
      const context = (error as CommandExecutionError).context;
      if (process.platform === "win32") {
        expect(context.exitCode).not.toBe(0);
      } else {
        expect(context.signal).toBe("SIGTERM");
      }
    }
  });
});

describe("command launch compatibility helpers", () => {
  it("detects Windows command shims after quote normalization", () => {
    expect(normalizeCommandPath('"C:/Program Files/node/npm.cmd"')).toBe(
      "C:/Program Files/node/npm.cmd"
    );
    expect(
      requiresShellLaunch('"C:/Program Files/node/npm.cmd"', "win32")
    ).toBe(true);
    expect(requiresShellLaunch("'C:/runtime/npm.bat'", "win32")).toBe(true);
    expect(
      getCommandLaunchOptions("C:/runtime/node.exe", { platform: "win32" })
    ).toEqual({});
    expect(
      getCommandLaunchOptions("/runtime/bin/npm", { platform: "linux" })
    ).toEqual({});
  });
});
