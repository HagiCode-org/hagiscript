import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  binCommand,
  createStageTracker,
  executableName,
  formatIntegrationSummary,
  runtimeNodeCommand,
  runtimeNpmCommand
} from "../../scripts/integration-platform-helpers.mjs";

describe("installed-runtime integration platform helpers", () => {
  it("constructs platform-specific npm and hagiscript command names", () => {
    expect(executableName("npm", "win32")).toBe("npm.cmd");
    expect(executableName("hagiscript", "win32")).toBe("hagiscript.cmd");
    expect(executableName("npm", "linux")).toBe("npm");
    expect(executableName("npm", "darwin")).toBe("npm");

    expect(binCommand("/tmp/project", "hagiscript", "linux")).toBe(
      path.join("/tmp/project", "node_modules", ".bin", "hagiscript")
    );
    expect(binCommand("C:/work/project", "hagiscript", "win32")).toBe(
      path.join("C:/work/project", "node_modules", ".bin", "hagiscript.cmd")
    );
  });

  it("constructs managed runtime executable paths for Windows and POSIX", () => {
    expect(runtimeNodeCommand("/tmp/node", "linux")).toBe(
      path.join("/tmp/node", "bin", "node")
    );
    expect(runtimeNpmCommand("/tmp/node", "darwin")).toBe(
      path.join("/tmp/node", "bin", "npm")
    );
    expect(runtimeNodeCommand("C:/runtime", "win32")).toBe(
      path.join("C:/runtime", "node.exe")
    );
    expect(runtimeNpmCommand("C:/runtime", "win32")).toBe(
      path.join("C:/runtime", "npm.cmd")
    );
  });

  it("tracks stage pass, failure, and skip outcomes", async () => {
    const tracker = createStageTracker();

    await expect(tracker.run("pass", async () => "ok")).resolves.toBe("ok");
    await expect(
      tracker.run("fail", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    tracker.skip("symlink creation", "missing privilege");

    expect(tracker.stages).toMatchObject([
      { name: "pass", status: "passed" },
      { name: "fail", status: "failed", error: "boom" }
    ]);
    expect(tracker.skipped).toEqual([
      { name: "symlink creation", reason: "missing privilege" }
    ]);
  });

  it("formats skipped checks separately from successful validations", () => {
    const summary = formatIntegrationSummary({
      diagnostics: {
        platform: "win32",
        arch: "x64",
        runnerOs: "Windows",
        runnerArch: "X64",
        nodeVersion: "v22.0.0",
        npmVersion: "10.9.2",
        tempRoot: "C:/temp/hagiscript-it",
        packageName: "hagiscript",
        packageVersion: "0.1.0"
      },
      stages: [
        { name: "platform diagnostics", status: "passed", durationMs: 1 },
        { name: "platform-specific checks", status: "passed", durationMs: 2 }
      ],
      skipped: [{ name: "symlink creation", reason: "missing privilege" }],
      finalResult: "passed"
    });

    expect(summary).toContain("- Final result: passed");
    expect(summary).toContain("- platform-specific checks: passed (2ms)");
    expect(summary).toContain("- symlink creation: skipped - missing privilege");
    expect(summary).not.toContain("- symlink creation: passed");
  });
});
