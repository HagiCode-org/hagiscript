import { describe, expect, it, vi } from "vitest";
import { createCli, runCli } from "../cli.js";

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
});
