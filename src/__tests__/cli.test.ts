import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCli, isCliEntrypoint, runCli } from "../cli.js";

describe("hagiscript CLI", () => {
  it("configures name, help, and version metadata", () => {
    const program = createCli();

    expect(program.name()).toBe("hagiscript");
    expect(program.helpInformation()).toContain(
      "Hagiscript language tooling CLI foundation."
    );
    expect(program.version()).toBe("0.1.0");
  });

  it("prints foundation info without global installation", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runCli(["node", "hagiscript", "info"]);

    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          packageName: "@hagicode/hagiscript",
          version: "0.1.0",
          status: "foundation"
        },
        null,
        2
      )}\n`
    );

    stdout.mockRestore();
  });

  it("recognizes npm bin symlinks as CLI entrypoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hagiscript-cli-"));
    const target = join(directory, "dist", "cli.js");
    const link = join(directory, "node_modules", ".bin", "hagiscript");

    await mkdir(join(directory, "dist"), { recursive: true });
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
    await writeFile(target, "");
    await symlink(target, link);

    expect(isCliEntrypoint(pathToFileURL(target).href, link)).toBe(true);
  });
});
