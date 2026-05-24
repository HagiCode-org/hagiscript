import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createZipArchive } from "./archive-test-utils.js";
import { extractZipArchive } from "../runtime/zip-extract.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("zip extraction", () => {
  it("prefers tar.exe on Windows before falling back to Node extraction", async () => {
    const root = await makeTempRoot();
    const archivePath = join(root, "fixture.zip");
    const destination = join(root, "extract");
    const attemptedCommands: string[] = [];

    await writeFile(
      archivePath,
      createZipArchive([{ name: "runtime/bin/tool.cmd", contents: "tool" }])
    );

    await extractZipArchive(archivePath, destination, {
      platform: "win32",
      runCommand: async (command: string, args: string[]) => {
        attemptedCommands.push(command);

        if (command !== "tar.exe") {
          throw new Error(`Unexpected fallback command: ${command}`);
        }

        await mkdir(join(destination, "runtime", "bin"), { recursive: true });
        await writeFile(join(destination, "runtime", "bin", "tool.cmd"), "tool");
        return {
          command,
          args,
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false
        };
      }
    });

    expect(attemptedCommands).toEqual(["tar.exe"]);
    await expect(readdir(join(destination, "runtime", "bin"))).resolves.toEqual([
      "tool.cmd"
    ]);
  });

  it("falls back through Windows native extractors before using the Node zip extractor", async () => {
    const root = await makeTempRoot();
    const archivePath = join(root, "fixture.zip");
    const destination = join(root, "extract");
    const attemptedCommands: string[] = [];

    await writeFile(
      archivePath,
      createZipArchive([{ name: "runtime/bin/tool.cmd", contents: "tool" }])
    );

    await extractZipArchive(archivePath, destination, {
      platform: "win32",
      runCommand: async (command: string) => {
        attemptedCommands.push(command);
        throw new Error(`${command} unavailable`);
      }
    });

    expect(attemptedCommands).toEqual([
      "tar.exe",
      "tar",
      "pwsh",
      "powershell.exe",
      "powershell"
    ]);
    await expect(readdir(join(destination, "runtime", "bin"))).resolves.toEqual([
      "tool.cmd"
    ]);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hagiscript-zip-extract-"));
  tempRoots.push(root);
  return root;
}
