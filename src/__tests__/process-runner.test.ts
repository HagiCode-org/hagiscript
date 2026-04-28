import { describe, expect, it } from "vitest";
import { runProcess } from "../../scripts/process-runner.mjs";

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
});
