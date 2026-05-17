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

const managedRoot = path.resolve("/managed-runtime")
const managedProgramRoot = path.join(managedRoot, "program")
const managedRuntimeDataRoot = path.join(managedRoot, "runtime-data")
const managedServerProgramRoot = path.join(managedRoot, "server")
const managedServerDataRoot = path.join(managedRoot, "server-data")

const runtimePaths: ResolvedRuntimePaths = {
  root: managedRoot,
  runtimeHome: managedProgramRoot,
  runtimeDataRoot: managedRuntimeDataRoot,
  serverProgramRoot: managedServerProgramRoot,
  serverDataRoot: managedServerDataRoot,
  bin: path.join(managedRuntimeDataRoot, "bin"),
  config: path.join(managedRuntimeDataRoot, "config"),
  logs: path.join(managedRuntimeDataRoot, "logs"),
  data: path.join(managedRuntimeDataRoot, "data"),
  stateFile: path.join(managedRuntimeDataRoot, "state.json"),
  componentsRoot: path.join(managedProgramRoot, "components"),
  componentDataRoot: path.join(managedRuntimeDataRoot, "components"),
  defaultPm2Home: "pm2",
  npmPrefix: path.join(managedRuntimeDataRoot, "npm"),
  nodeRuntime: path.join(managedProgramRoot, "components", "node", "runtime"),
  dotnetRuntime: path.join(managedProgramRoot, "components", "dotnet", "runtime"),
  vendoredRoot: path.join(managedProgramRoot, "components", "bundled")
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
    expect(getComponentManagedRoot(runtimePaths, "server")).toBe(managedServerProgramRoot)
    expect(getComponentRuntimeDataHome(runtimePaths, "server", "services/server")).toBe(
      managedServerDataRoot
    )
    expect(getServerProgramRoot(runtimePaths)).toBe(managedServerProgramRoot)
    expect(getServerVersionsRoot(runtimePaths)).toBe(path.join(managedServerProgramRoot, "versions"))
    expect(getServerVersionRoot(runtimePaths, "1.2.3")).toBe(
      path.join(managedServerProgramRoot, "versions", "1.2.3")
    )
    expect(getServerSharedDataRoot(runtimePaths)).toBe(managedServerDataRoot)
    expect(getComponentPm2Home(runtimePaths, "server", "services/server", ".pm2")).toBe(
      path.join(managedServerDataRoot, ".pm2")
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

    expect(resolvedPaths.serverProgramRoot).toBe(path.join(managedRoot, "server"))
    expect(resolvedPaths.serverDataRoot).toBe(path.join(managedRoot, "server-data"))
  })

  it("falls back to legacy server roots when standalone paths are not configured", () => {
    const resolvedPaths = resolveRuntimePaths(createManifest({}))

    expect(getComponentManagedRoot(resolvedPaths, "server")).toBe(path.join(managedRoot, "program", "server"))
    expect(getComponentRuntimeDataHome(resolvedPaths, "server", "services/server")).toBe(
      path.join(managedRoot, "runtime-data", "server")
    )
    expect(resolvedPaths.serverProgramRoot).toBe(path.join(managedRoot, "program", "server"))
    expect(resolvedPaths.serverDataRoot).toBe(path.join(managedRoot, "runtime-data", "server"))
  })

  it("supports explicit root overrides for program and data trees", () => {
    const customProgramRoot = "/custom/program"
    const customRuntimeDataRoot = "/custom/runtime-data"
    const resolvedPaths = resolveRuntimePaths(createManifest({}), {
      runtimeRoot: "/override-root",
      runtimeHome: customProgramRoot,
      runtimeDataRoot: customRuntimeDataRoot,
      serverProgramRoot: "/custom/server",
      serverDataRoot: "/custom/server-data"
    })

    expect(resolvedPaths.root).toBe(path.resolve("/override-root"))
    expect(resolvedPaths.runtimeHome).toBe(customProgramRoot)
    expect(resolvedPaths.runtimeDataRoot).toBe(customRuntimeDataRoot)
    expect(resolvedPaths.serverProgramRoot).toBe("/custom/server")
    expect(resolvedPaths.serverDataRoot).toBe("/custom/server-data")
    expect(resolvedPaths.componentsRoot).toBe(path.resolve(customProgramRoot, "components"))
    expect(resolvedPaths.nodeRuntime).toBe(
      path.resolve(customProgramRoot, "components", "node", "runtime")
    )
    expect(resolvedPaths.componentDataRoot).toBe(path.resolve(customRuntimeDataRoot, "components"))
    expect(resolvedPaths.npmPrefix).toBe(path.resolve(customRuntimeDataRoot, "npm"))
  })
})
