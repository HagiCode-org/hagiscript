import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createRuntimeInfo,
  getPackageMetadata,
  packageName,
  packageVersion
} from "../index.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as {
  name: string;
  version: string;
};

describe("hagiscript public API", () => {
  it("exports package metadata", () => {
    expect(packageName).toBe(packageJson.name);
    expect(packageVersion).toBe(packageJson.version);
    expect(getPackageMetadata()).toEqual({
      name: packageJson.name,
      version: packageJson.version
    });
  });

  it("creates runtime foundation info", () => {
    expect(createRuntimeInfo()).toEqual({
      packageName: packageJson.name,
      version: packageJson.version,
      status: "foundation"
    });
  });
});
