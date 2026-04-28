import { describe, expect, it } from "vitest";
import {
  createSpawnSpec,
  requiresShell
} from "../../scripts/process-runner.mjs";

describe("process runner spawn spec", () => {
  it("routes Windows batch shims through cmd.exe with quoted arguments", () => {
    const command = "C:/Program Files/HagiScript/hagiscript.cmd";
    const spec = createSpawnSpec(
      command,
      [
        "npm-sync",
        "--prefix",
        "C:/Users/runner/AppData/Local/Temp/npm prefix with spaces"
      ],
      {},
      "win32"
    );

    expect(requiresShell(command, "win32")).toBe(true);
    expect(spec).toEqual({
      command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '"\"C:/Program Files/HagiScript/hagiscript.cmd\" npm-sync --prefix \"C:/Users/runner/AppData/Local/Temp/npm prefix with spaces\""'
      ],
      shell: false,
      windowsVerbatimArguments: true
    });
  });

  it("keeps direct process spawning for non-Windows commands", () => {
    const spec = createSpawnSpec(
      "/tmp/hagiscript",
      ["npm-sync", "--prefix", "/tmp/npm prefix with spaces"],
      {},
      "linux"
    );

    expect(requiresShell("/tmp/hagiscript", "linux")).toBe(false);
    expect(spec).toEqual({
      command: "/tmp/hagiscript",
      args: ["npm-sync", "--prefix", "/tmp/npm prefix with spaces"],
      shell: false,
      windowsVerbatimArguments: false
    });
  });
});
