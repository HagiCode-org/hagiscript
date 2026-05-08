import { describe, expect, it } from "vitest"
import { resolveManagedPath, resolveReleasedServicePath } from "../runtime/runtime-paths.js"

describe("runtime path helpers", () => {
  it("keeps POSIX absolute paths unchanged across platforms", () => {
    expect(resolveManagedPath("/opt/hagicode/local-publishment/lib", "D:\\managed-runtime")).toBe(
      "/opt/hagicode/local-publishment/lib"
    )
    expect(
      resolveReleasedServicePath(
        "/opt/hagicode/local-publishment/lib/PCode.Web.dll",
        "D:\\managed-runtime\\program\\components\\server"
      )
    ).toBe("/opt/hagicode/local-publishment/lib/PCode.Web.dll")
  })

  it("keeps Windows absolute paths unchanged across platforms", () => {
    expect(resolveManagedPath("D:\\opt\\hagicode\\local-publishment\\lib", "/managed-runtime")).toBe(
      "D:\\opt\\hagicode\\local-publishment\\lib"
    )
  })
})
