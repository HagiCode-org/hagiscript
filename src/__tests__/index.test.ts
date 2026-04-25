import { describe, expect, it } from "vitest";
import {
  createRuntimeInfo,
  getPackageMetadata,
  packageName,
  packageVersion
} from "../index.js";

describe("hagiscript public API", () => {
  it("exports package metadata", () => {
    expect(packageName).toBe("hagiscript");
    expect(packageVersion).toBe("0.1.0");
    expect(getPackageMetadata()).toEqual({
      name: "hagiscript",
      version: "0.1.0"
    });
  });

  it("creates runtime foundation info", () => {
    expect(createRuntimeInfo()).toEqual({
      packageName: "hagiscript",
      version: "0.1.0",
      status: "foundation"
    });
  });
});
