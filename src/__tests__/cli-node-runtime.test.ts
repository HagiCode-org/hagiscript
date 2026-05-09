import { describe, expect, it, vi } from "vitest";
import { createCli, runCli } from "../cli.js";

const { installNodeRuntime } = vi.hoisted(() => ({
  installNodeRuntime: vi.fn(async () => ({
    version: "v22.12.0",
    npmVersion: "10.9.0",
    targetDirectory: "/tmp/runtime",
    nodePath: "/tmp/runtime/bin/node",
    npmPath: "/tmp/runtime/bin/npm",
    archiveUrl:
      "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz"
  }))
}));

vi.mock("../runtime/node-installer.js", () => ({
  installNodeRuntime
}));

vi.mock("../runtime/node-verify.js", () => ({
  verifyNodeRuntime: vi.fn(async (targetDirectory: string) => ({
    valid: targetDirectory !== "/bad/runtime",
    targetDirectory,
    nodeVersion: "v22.12.0",
    npmVersion: "10.9.0",
    nodePath: `${targetDirectory}/bin/node`,
    npmPath: `${targetDirectory}/bin/npm`,
    failureReason:
      targetDirectory === "/bad/runtime" ? "missing executable" : undefined
  }))
}));

describe("node runtime CLI commands", () => {
  it("includes install-node and check-node in help output", () => {
    const output = createCli().helpInformation();

    expect(output).toContain("install-node");
    expect(output).toContain("check-node");
  });

  it("installs Node.js with default version selector", async () => {
    installNodeRuntime.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "install-node",
      "--target",
      "/tmp/runtime"
    ]);

    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("Installing Node.js 22 into /tmp/runtime");
    expect(output).toContain("Node.js runtime installed successfully.");
    expect(installNodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDirectory: "/tmp/runtime",
        downloadCacheEnabled: true
      })
    );
    stdout.mockRestore();
  });

  it("passes explicit download cache settings into install-node", async () => {
    installNodeRuntime.mockClear();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "install-node",
      "--target",
      "/tmp/runtime",
      "--no-download-cache",
      "--download-cache-dir",
      "/tmp/download-cache"
    ]);

    expect(installNodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDirectory: "/tmp/runtime",
        downloadCacheEnabled: false,
        downloadCacheDirectory: "/tmp/download-cache"
      })
    );

    stdout.mockRestore();
  });

  it("validates an existing Node.js runtime", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli([
      "node",
      "hagiscript",
      "check-node",
      "--target",
      "/tmp/runtime"
    ]);

    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("Node.js runtime is valid.");
    stdout.mockRestore();
  });

  it("rejects invalid version selectors", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCli([
        "node",
        "hagiscript",
        "install-node",
        "--target",
        "/tmp/runtime",
        "--version",
        "bad"
      ])
    ).rejects.toThrow();

    stderr.mockRestore();
  });
});
