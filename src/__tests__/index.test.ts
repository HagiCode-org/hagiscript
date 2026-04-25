import { describe, expect, it } from "vitest";
import {
  createRuntimeInfo,
  getPackageMetadata,
  packageName,
  packageVersion
} from "../index.js";

describe("hagiscript public API", () => {
  it("exports package metadata", () => {
    expect(packageName).toBe("@hagicode/hagiscript");
    expect(packageVersion).toBe("0.1.0");
    expect(getPackageMetadata()).toEqual({
      name: "@hagicode/hagiscript",
      version: "0.1.0"
    });
  });

  it("creates runtime foundation info", () => {
    expect(createRuntimeInfo()).toEqual({
      packageName: "@hagicode/hagiscript",
      version: "0.1.0",
      status: "foundation"
    });
  });
});
