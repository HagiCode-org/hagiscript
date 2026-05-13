import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  installManagedServer,
  resolveManagedServerStartupEnvironment,
  startManagedServer
} from "../runtime/server-manager.js"

describe("server manager", () => {
  it("stages a local server archive, installs the runtime component, and ensures pm2", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-manager-"))
    const manifestPath = path.join(directory, "manifest.yaml")
    const runtimeRoot = path.join(directory, "runtime-root")
    const archivePath = path.join(directory, "hagicode-1.2.3-linux-x64-nort.zip")

    const installRuntimeFn = vi.fn(async () => ({
      manifest: {
        manifestPath,
        runtime: { name: "fixture-runtime", version: "1.0.0" }
      },
      paths: { root: runtimeRoot },
      state: {},
      plan: [{ componentName: "server", phase: "install", strategy: "script" }],
      skipped: [],
      changedComponents: ["node", "dotnet", "server"],
      logFilePath: path.join(runtimeRoot, "runtime-data", "logs", "install.log")
    }))
    const queryRuntimeStateFn = vi.fn(async () => ({
      runtime: {
        name: "fixture-runtime",
        version: "1.0.0",
        manifestPath
      },
      managedRoot: runtimeRoot,
      managedPaths: {},
      layout: {
        separated: true,
        runtimeHome: path.join(runtimeRoot, "program"),
        runtimeDataRoot: path.join(runtimeRoot, "runtime-data"),
        programRoots: [],
        externalDataRoots: []
      },
      ready: true,
      components: [],
      lastOperation: null
    }))
    const syncNpmGlobalsFn = vi.fn(async () => ({
      runtime: {
        targetDirectory: path.join(runtimeRoot, "program", "components", "node", "runtime"),
        nodePath: "/tmp/node",
        npmPath: "/tmp/npm",
        nodeVersion: "22.0.0",
        npmVersion: "10.0.0"
      },
      manifestPath: "/tmp/manifest.json",
      packageCount: 1,
      syncMode: "packages",
      fallbackPolicy: "auto",
      fallbackUsed: false,
      fallbackEvents: [],
      noopCount: 0,
      changedCount: 1,
      actions: []
    }))

    await writeFile(
      archivePath,
      "placeholder archive",
      "utf8"
    )
    await writeFile(
      manifestPath,
      `runtime:
  name: "fixture-runtime"
  version: "1.0.0"
paths:
  runtimeRoot: "~/.hagicode/runtime"
  runtimeHome: "program"
  runtimeDataRoot: "runtime-data"
  bin: "bin"
  config: "config"
  logs: "logs"
  data: "data"
  stateFile: "state.json"
  componentsRoot: "components"
  componentDataRoot: "components"
  defaultPm2Home: "pm2"
  npmPrefix: "npm"
  nodeRuntime: "components/node/runtime"
  dotnetRuntime: "components/dotnet/runtime"
  vendoredRoot: "components/bundled"
phases:
  install:
    order: ["node", "dotnet", "server"]
  remove:
    order: ["server", "dotnet", "node"]
  update:
    order: ["node", "dotnet", "server"]
components:
  - name: "node"
    type: "runtime"
    installScript: "${archivePath.replaceAll("\\", "/")}"
  - name: "dotnet"
    type: "runtime"
    installScript: "${archivePath.replaceAll("\\", "/")}"
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    lifecycleDependencies: ["node", "dotnet"]
    installScript: "${archivePath.replaceAll("\\", "/")}"
    configureScript: "${archivePath.replaceAll("\\", "/")}"
    pm2:
      appName: "fixture-server"
      nameIdentifierEnv: "hagicode_pm2_name"
      pm2Home: ".pm2"
    releasedService:
      dllPath: "current/lib/PCode.Web.dll"
      workingDirectory: "current/lib"
      runtimeFilesDir: "pm2-runtime"
`,
      "utf8"
    )

    try {
      const result = await installManagedServer({
        manifestPath,
        runtimeRoot,
        archivePath,
        pm2Version: "^6.0.0",
        installRuntimeFn,
        queryRuntimeStateFn,
        syncNpmGlobalsFn,
        extractArchive: async (_archivePath, extractRoot) => {
          const libRoot = path.join(extractRoot, "package", "lib")
          await mkdir(libRoot, { recursive: true })
          await writeFile(path.join(libRoot, "PCode.Web.dll"), "dll", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.deps.json"), "deps", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.runtimeconfig.json"), "runtimeconfig", "utf8")
        }
      })

      expect(result.source.kind).toBe("local-archive")
      expect(result.stagedDllPath).toBe(
        path.join(runtimeRoot, "program", "components", "server", "current", "lib", "PCode.Web.dll")
      )
      expect(installRuntimeFn).toHaveBeenCalledWith(
        expect.objectContaining({
          manifestPath,
          runtimeRoot,
          components: ["server"]
        })
      )
      expect(syncNpmGlobalsFn).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePath: path.join(runtimeRoot, "program", "components", "node", "runtime"),
          npmOptions: {
            prefix: path.join(runtimeRoot, "program", "npm")
          }
        })
      )
      expect(queryRuntimeStateFn).toHaveBeenCalledWith({
        manifestPath,
        runtimeRoot
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("passes the default or explicit instance name into PM2 operations", async () => {
    const pm2Module = await import("../runtime/pm2-manager.js")
    const runManagedPm2Command = vi
      .spyOn(pm2Module, "runManagedPm2Command")
      .mockResolvedValue({} as never)
    const resolveManagedPm2Environment = vi
      .spyOn(pm2Module, "resolveManagedPm2Environment")
      .mockResolvedValue({} as never)

    try {
      await startManagedServer({ runtimeRoot: "/tmp/runtime-root" })
      await resolveManagedServerStartupEnvironment({
        runtimeRoot: "/tmp/runtime-root",
        instanceName: "demo"
      })

      expect(runManagedPm2Command).toHaveBeenCalledWith({
        manifestPath: undefined,
        runtimeRoot: "/tmp/runtime-root",
        service: "server",
        action: "start",
        nameIdentifierValue: "hagicode"
      })
      expect(resolveManagedPm2Environment).toHaveBeenCalledWith({
        manifestPath: undefined,
        runtimeRoot: "/tmp/runtime-root",
        service: "server",
        nameIdentifierValue: "demo"
      })
    } finally {
      runManagedPm2Command.mockRestore()
      resolveManagedPm2Environment.mockRestore()
    }
  })
})
