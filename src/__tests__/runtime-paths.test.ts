import { homedir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  getComponentManagedRoot,
  getComponentPm2Home,
  getComponentRuntimeDataHome,
  getServerProgramRoot,
  getServerSharedDataRoot,
  getServerVersionRoot,
  getServerVersionsRoot,
  resolveRuntimePaths,
  resolveManagedPath,
  resolveReleasedServicePath,
  type ResolvedRuntimePaths
} from "../runtime/runtime-paths.js"
import type { LoadedRuntimeManifest } from "../runtime/runtime-manifest.js"

const runtimePaths: ResolvedRuntimePaths = {
  root: "/managed-runtime",
  runtimeHome: "/managed-runtime/program",
  runtimeDataRoot: "/managed-runtime/runtime-data",
  serverProgramRoot: "/managed-runtime/server",
  serverDataRoot: "/managed-runtime/server-data",
  bin: "/managed-runtime/runtime-data/bin",
  config: "/managed-runtime/runtime-data/config",
  logs: "/managed-runtime/runtime-data/logs",
  data: "/managed-runtime/runtime-data/data",
  stateFile: "/managed-runtime/runtime-data/state.json",
  componentsRoot: "/managed-runtime/program/components",
  componentDataRoot: "/managed-runtime/runtime-data/components",
  defaultPm2Home: "pm2",
  npmPrefix: "/managed-runtime/runtime-data/npm",
  nodeRuntime: "/managed-runtime/program/components/node/runtime",
  dotnetRuntime: "/managed-runtime/program/components/dotnet/runtime",
  vendoredRoot: "/managed-runtime/program/components/bundled"
}

function createManifest(pathOverrides: Partial<LoadedRuntimeManifest["paths"]>): LoadedRuntimeManifest {
  return {
    manifestPath: "/fixtures/runtime-manifest.yaml",
    manifestDir: "/fixtures",
    runtime: {
      name: "fixture-runtime",
      version: "1.0.0"
    },
    components: [],
    componentMap: new Map(),
    phases: {
      install: { order: [], reverse: false },
      remove: { order: [], reverse: true },
      update: { order: [], reverse: false }
    },
    paths: {
      runtimeRoot: "/managed-runtime",
      runtimeHome: "program",
      runtimeDataRoot: "runtime-data",
      bin: "bin",
      config: "config",
      logs: "logs",
      data: "data",
      stateFile: "state.json",
      componentsRoot: "components",
      componentDataRoot: "components",
      defaultPm2Home: "pm2",
      npmPrefix: "npm",
      nodeRuntime: "components/node/runtime",
      dotnetRuntime: "components/dotnet/runtime",
      vendoredRoot: "components/bundled",
      ...pathOverrides
    }
  }
}

describe("runtime path helpers", () => {
  const expectedDefaultPm2Root = path.join(homedir(), ".hagiscript", "pm2")

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

  it("builds dedicated server program and shared data roots", () => {
    expect(getComponentManagedRoot(runtimePaths, "server")).toBe("/managed-runtime/server")
    expect(getComponentRuntimeDataHome(runtimePaths, "server", "services/server")).toBe(
      "/managed-runtime/server-data"
    )
    expect(getServerProgramRoot(runtimePaths)).toBe("/managed-runtime/server")
    expect(getServerVersionsRoot(runtimePaths)).toBe("/managed-runtime/server/versions")
    expect(getServerVersionRoot(runtimePaths, "1.2.3")).toBe(
      "/managed-runtime/server/versions/1.2.3"
    )
    expect(getServerSharedDataRoot(runtimePaths)).toBe("/managed-runtime/server-data")
    expect(getComponentPm2Home(runtimePaths, "server", "services/server", ".pm2")).toBe(
      "/managed-runtime/server-data/.pm2"
    )
  })

  it("uses the shared user PM2 root for default service homes", () => {
    expect(getComponentPm2Home(runtimePaths, "omniroute", "services/omniroute")).toBe(
      path.join(expectedDefaultPm2Root, "omniroute")
    )
    expect(getComponentPm2Home(runtimePaths, "alpha", "alpha-data")).toBe(
      path.join(expectedDefaultPm2Root, "alpha")
    )
    expect(getComponentPm2Home(runtimePaths, "server", "services/server")).toBe(
      path.join(expectedDefaultPm2Root, "server")
    )
  })

  it("can derive the shared user PM2 home from a service name", () => {
    expect(
      getComponentPm2Home(
        runtimePaths,
        "server",
        "services/server",
        undefined,
        "fixture-server"
      )
    ).toBe(path.join(expectedDefaultPm2Root, "fixture-server"))
  })

  it("uses distinct default PM2 homes per component", () => {
    expect(getComponentPm2Home(runtimePaths, "omniroute", "services/omniroute")).not.toBe(
      getComponentPm2Home(runtimePaths, "code-server", "services/code-server")
    )
    expect(getComponentPm2Home(runtimePaths, "server", "services/server")).not.toBe(
      getComponentPm2Home(runtimePaths, "alpha", "alpha-data")
    )
  })

  it("resolves configured standalone server roots from the manifest", () => {
    const resolvedPaths = resolveRuntimePaths(
      createManifest({
        serverProgramRoot: "server",
        serverDataRoot: "server-data"
      })
    )

    expect(resolvedPaths.serverProgramRoot).toBe("/managed-runtime/server")
    expect(resolvedPaths.serverDataRoot).toBe("/managed-runtime/server-data")
  })

  it("falls back to legacy server roots when standalone paths are not configured", () => {
    const resolvedPaths = resolveRuntimePaths(createManifest({}))

    expect(getComponentManagedRoot(resolvedPaths, "server")).toBe("/managed-runtime/program/server")
    expect(getComponentRuntimeDataHome(resolvedPaths, "server", "services/server")).toBe(
      "/managed-runtime/runtime-data/server"
    )
    expect(resolvedPaths.serverProgramRoot).toBe("/managed-runtime/program/server")
    expect(resolvedPaths.serverDataRoot).toBe("/managed-runtime/runtime-data/server")
  })

  it("supports explicit root overrides for program and data trees", () => {
    const resolvedPaths = resolveRuntimePaths(createManifest({}), {
      runtimeRoot: "/override-root",
      runtimeHome: "/custom/program",
      runtimeDataRoot: "/custom/runtime-data",
      serverProgramRoot: "/custom/server",
      serverDataRoot: "/custom/server-data"
    })

    expect(resolvedPaths.root).toBe("/override-root")
    expect(resolvedPaths.runtimeHome).toBe("/custom/program")
    expect(resolvedPaths.runtimeDataRoot).toBe("/custom/runtime-data")
    expect(resolvedPaths.serverProgramRoot).toBe("/custom/server")
    expect(resolvedPaths.serverDataRoot).toBe("/custom/server-data")
    expect(resolvedPaths.componentsRoot).toBe("/custom/program/components")
    expect(resolvedPaths.nodeRuntime).toBe("/custom/program/components/node/runtime")
    expect(resolvedPaths.componentDataRoot).toBe("/custom/runtime-data/components")
    expect(resolvedPaths.npmPrefix).toBe("/custom/runtime-data/npm")
  })
})
