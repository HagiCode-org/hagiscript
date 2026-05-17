import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  installManagedServer,
  resolveManagedServerEnvironment,
  resolveManagedServerStartupEnvironment,
  startManagedServer
} from "../runtime/server-manager.js"

describe("server manager", () => {
  it("stages a local server archive, installs runtime dependencies, and ensures managed pm2", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-manager-"))
    const manifestPath = path.join(directory, "manifest.yaml")
    const runtimeRoot = path.join(directory, "runtime-root")
    const archivePath = path.join(directory, getManagedServerAssetName("1.2.3"))
    const runtimeManagerModule = await import("../runtime/runtime-manager.js")
    const ensureManagedPm2Package = vi
      .spyOn(runtimeManagerModule, "ensureManagedPm2Package")
      .mockResolvedValue({
        changed: true,
        installedVersion: null,
        selector: "pm2@^7.0.0",
        prefix: path.join(runtimeRoot, "runtime-data", "npm")
      })

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
      nameIdentifierEnv: "hagicode_instance"
      pm2Home: ".pm2"
    releasedService:
      dllPath: "lib/PCode.Web.dll"
      workingDirectory: "lib"
      runtimeFilesDir: "pm2-runtime"
npmSync:
  packages:
    pm2:
      version: "7.0.1"
      target: "7.0.1"
`,
      "utf8"
    )

    try {
      const result = await installManagedServer({
        manifestPath,
        runtimeRoot,
        archivePath,
        pm2Version: "^7.0.0",
        installRuntimeFn,
        queryRuntimeStateFn,
        extractArchive: async (_archivePath, extractRoot) => {
          const libRoot = path.join(extractRoot, "package", "lib")
          await mkdir(libRoot, { recursive: true })
          await writeFile(path.join(libRoot, "PCode.Web.dll"), "dll", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.deps.json"), "deps", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.runtimeconfig.json"), "runtimeconfig", "utf8")
        }
      })

      expect(result.source.kind).toBe("local-archive")
      expect(result.installedVersion).toBe("1.2.3")
      expect(result.activeVersion).toBe("1.2.3")
      expect(result.stagedDllPath).toBe(
        path.join(runtimeRoot, "program", "server", "versions", "1.2.3", "lib", "PCode.Web.dll")
      )
      expect(installRuntimeFn).toHaveBeenCalledWith(
        expect.objectContaining({
          manifestPath,
          runtimeRoot,
          components: ["node", "dotnet"],
          pm2VersionOverride: "^7.0.0"
        })
      )
      expect(ensureManagedPm2Package).toHaveBeenCalledWith(
        expect.objectContaining({ manifestPath }),
        expect.objectContaining({ root: runtimeRoot }),
        {
          npmRegistryMirror: undefined,
          pm2VersionOverride: "^7.0.0"
        }
      )
      expect(queryRuntimeStateFn).toHaveBeenCalledWith({
        manifestPath,
        runtimeRoot
      })
    } finally {
      ensureManagedPm2Package.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("passes the default or explicit instance name into PM2 operations", async () => {
    const runtimeRoot = "/tmp/runtime-root"
    const runtimeDataRoot = path.join(runtimeRoot, "runtime-data", "server")
    const configPath = path.join(runtimeDataRoot, "config", "server-config.json")
    const pm2Module = await import("../runtime/pm2-manager.js")
    const serverConfigModule = await import("../runtime/server-config.js")
    const runManagedPm2Command = vi
      .spyOn(pm2Module, "runManagedPm2Command")
      .mockResolvedValue({} as never)
    const resolveManagedPm2Environment = vi
      .spyOn(pm2Module, "resolveManagedPm2Environment")
      .mockResolvedValue({} as never)
    const getManagedServerConfig = vi
      .spyOn(serverConfigModule, "getManagedServerConfig")
      .mockResolvedValue({
        host: "127.0.0.1",
        port: 39150,
        aspNetCoreUrls: "http://127.0.0.1:39150",
        configPath,
        source: "config-file"
      })

    try {
      await startManagedServer({ runtimeRoot })
      await resolveManagedServerStartupEnvironment({
        runtimeRoot,
        instanceName: "demo"
      })

      expect(runManagedPm2Command).toHaveBeenNthCalledWith(1, {
        manifestPath: undefined,
        runtimeRoot,
        service: "code-server",
        action: "start",
        nameIdentifierValue: undefined
      })
      expect(runManagedPm2Command).toHaveBeenNthCalledWith(2, {
        manifestPath: undefined,
        runtimeRoot,
        service: "omniroute",
        action: "start",
        nameIdentifierValue: undefined
      })
      expect(runManagedPm2Command).toHaveBeenNthCalledWith(3, {
        manifestPath: undefined,
        runtimeRoot,
        service: "server",
        action: "start",
        nameIdentifierValue: undefined,
        environmentOverrides: {
          ASPNETCORE_URLS: "http://127.0.0.1:39150",
          Urls: "http://127.0.0.1:39150",
          DATADIR: path.join(runtimeDataRoot, "data"),
          VsCodeServer__Host: "127.0.0.1",
          VsCodeServer__Port: "8080",
          VsCodeServer__AuthMode: "none",
          VsCodeServer__Source: "external",
          VsCodeServer__SourceLocked: "true",
          OmniRoute__Enabled: "true",
          OmniRoute__ApiEndpoint: "http://127.0.0.1:39001/",
          OmniRoute__DefaultBaseUrl: "http://127.0.0.1:39001/",
          OmniRoute__DefaultBaseUrlSource: "external",
          OmniRoute__DefaultBaseUrlLocked: "true"
        }
      })
      expect(resolveManagedPm2Environment).toHaveBeenCalledWith({
        manifestPath: undefined,
        runtimeRoot,
        service: "server",
        nameIdentifierValue: "demo",
        environmentOverrides: {
          ASPNETCORE_URLS: "http://127.0.0.1:39150",
          Urls: "http://127.0.0.1:39150",
          DATADIR: path.join(runtimeDataRoot, "data"),
          VsCodeServer__Host: "127.0.0.1",
          VsCodeServer__Port: "8080",
          VsCodeServer__AuthMode: "none",
          VsCodeServer__Source: "external",
          VsCodeServer__SourceLocked: "true",
          OmniRoute__Enabled: "true",
          OmniRoute__ApiEndpoint: "http://127.0.0.1:39001/",
          OmniRoute__DefaultBaseUrl: "http://127.0.0.1:39001/",
          OmniRoute__DefaultBaseUrlSource: "external",
          OmniRoute__DefaultBaseUrlLocked: "true"
        }
      })
    } finally {
      runManagedPm2Command.mockRestore()
      resolveManagedPm2Environment.mockRestore()
      getManagedServerConfig.mockRestore()
    }
  })

  it("resolves managed server environment details inside hagiscript", async () => {
    const runtimeRoot = "/tmp/runtime-root"
    const configPath = path.join(runtimeRoot, "runtime-data", "server", "config", "server-config.json")
    const sharedDataRoot = path.dirname(path.dirname(configPath))
    const serverConfigModule = await import("../runtime/server-config.js")
    const getManagedServerConfig = vi
      .spyOn(serverConfigModule, "getManagedServerConfig")
      .mockResolvedValue({
        host: "127.0.0.1",
        port: 39150,
        aspNetCoreUrls: "http://127.0.0.1:39150",
        configPath,
        source: "config-file"
      })

    try {
      const result = await resolveManagedServerEnvironment({
        runtimeRoot
      })

      expect(result).toEqual({
        host: "127.0.0.1",
        port: 39150,
        aspNetCoreUrls: "http://127.0.0.1:39150",
        configPath,
        sharedDataRoot,
        environment: {
          ASPNETCORE_URLS: "http://127.0.0.1:39150",
          Urls: "http://127.0.0.1:39150",
          DATADIR: path.join(sharedDataRoot, "data"),
          VsCodeServer__Host: "127.0.0.1",
          VsCodeServer__Port: "8080",
          VsCodeServer__AuthMode: "none",
          VsCodeServer__Source: "external",
          VsCodeServer__SourceLocked: "true",
          OmniRoute__Enabled: "true",
          OmniRoute__ApiEndpoint: "http://127.0.0.1:39001/",
          OmniRoute__DefaultBaseUrl: "http://127.0.0.1:39001/",
          OmniRoute__DefaultBaseUrlSource: "external",
          OmniRoute__DefaultBaseUrlLocked: "true"
        }
      })
    } finally {
      getManagedServerConfig.mockRestore()
    }
  })

  it("derives integration environment from managed component configs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-env-"))
    const manifestPath = path.join(directory, "manifest.yaml")
    const runtimeRoot = path.join(directory, "runtime-root")
    const serverConfigPath = path.join(runtimeRoot, "runtime-data", "server", "config", "server-config.json")
    const omnirouteConfigPath = path.join(
      runtimeRoot,
      "runtime-data",
      "components",
      "services",
      "omniroute",
      "config",
      "config.yaml"
    )
    const codeServerConfigPath = path.join(
      runtimeRoot,
      "runtime-data",
      "components",
      "services",
      "code-server",
      "config",
      "config.yaml"
    )

    await mkdir(path.dirname(serverConfigPath), { recursive: true })
    await mkdir(path.dirname(omnirouteConfigPath), { recursive: true })
    await mkdir(path.dirname(codeServerConfigPath), { recursive: true })
    await writeFile(
      manifestPath,
      `runtime:
  name: "fixture-runtime"
  version: "1.0.0"
paths:
  runtimeRoot: "~/.hagicode/runtime"
  runtimeHome: "program"
  runtimeDataRoot: "runtime-data"
  serverDataRoot: "runtime-data/server"
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
    order: ["server", "omniroute", "code-server"]
  remove:
    order: ["code-server", "omniroute", "server"]
  update:
    order: ["server", "omniroute", "code-server"]
components:
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    lifecycleDependencies: []
    installScript: "${manifestPath.replaceAll("\\", "/")}"
    pm2:
      nameIdentifierEnv: "hagicode_instance"
      env:
        ASPNETCORE_URLS: "http://127.0.0.1:39150"
    releasedService:
      dllPath: "lib/PCode.Web.dll"
      workingDirectory: "lib"
  - name: "omniroute"
    type: "bundled-runtime"
    runtimeDataDir: "services/omniroute"
    lifecycleDependencies: []
    installScript: "${manifestPath.replaceAll("\\", "/")}"
  - name: "code-server"
    type: "bundled-runtime"
    runtimeDataDir: "services/code-server"
    lifecycleDependencies: []
    installScript: "${manifestPath.replaceAll("\\", "/")}"
`,
      "utf8"
    )
    await writeFile(
      serverConfigPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 39150,
        aspNetCoreUrls: "http://127.0.0.1:39150"
      }),
      "utf8"
    )
    await writeFile(omnirouteConfigPath, 'listen: "127.0.0.1:41001"\n', "utf8")
    await writeFile(
      codeServerConfigPath,
      'bind-addr: 127.0.0.1:18080\nauth: password\npassword: s3cr3t\n',
      "utf8"
    )

    try {
      const result = await resolveManagedServerEnvironment({ manifestPath, runtimeRoot })

      expect(result.environment).toEqual({
        ASPNETCORE_URLS: "http://127.0.0.1:39150",
        Urls: "http://127.0.0.1:39150",
        DATADIR: path.join(runtimeRoot, "runtime-data", "server", "data"),
        VsCodeServer__Host: "127.0.0.1",
        VsCodeServer__Port: "18080",
        VsCodeServer__AuthMode: "password",
        VsCodeServer__Secret: "s3cr3t",
        VsCodeServer__SecretSource: "bootstrap",
        VsCodeServer__Source: "external",
        VsCodeServer__SourceLocked: "true",
        OmniRoute__Enabled: "true",
        OmniRoute__ApiEndpoint: "http://127.0.0.1:41001/",
        OmniRoute__DefaultBaseUrl: "http://127.0.0.1:41001/",
        OmniRoute__DefaultBaseUrlSource: "external",
        OmniRoute__DefaultBaseUrlLocked: "true"
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("downloads server archive from HTTP index download sources", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-index-"))
    const manifestPath = path.join(directory, "manifest.yaml")
    const runtimeRoot = path.join(directory, "runtime-root")
    const scriptsDir = path.join(directory, "scripts")

    const installRuntimeFn = vi.fn(async () => ({
      manifest: {
        manifestPath,
        runtime: { name: "fixture-runtime", version: "1.0.0" }
      },
      paths: { root: runtimeRoot },
      state: {},
      plan: [{ componentName: "server", phase: "install", strategy: "script" }],
      skipped: [],
      changedComponents: ["server"],
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

    await mkdir(scriptsDir, { recursive: true })
    await Promise.all([
      writeFile(path.join(scriptsDir, "install-node.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "install-dotnet.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "install-server.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "configure-server.mjs"), "export {}\n", "utf8")
    ])

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
    installScript: "scripts/install-node.mjs"
  - name: "dotnet"
    type: "runtime"
    installScript: "scripts/install-dotnet.mjs"
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    lifecycleDependencies: ["node", "dotnet"]
    installScript: "scripts/install-server.mjs"
    configureScript: "scripts/configure-server.mjs"
    pm2:
      appName: "fixture-server"
      nameIdentifierEnv: "hagicode_instance"
      pm2Home: ".pm2"
    releasedService:
      dllPath: "lib/PCode.Web.dll"
      workingDirectory: "lib"
      runtimeFilesDir: "pm2-runtime"
`,
      "utf8"
    )

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          versions: [
            {
              version: "1.2.3",
              channels: ["stable"],
              assets: [
                {
                  name: getManagedServerAssetName("1.2.3"),
                  downloadSources: [
                    {
                      kind: "mirror",
                      label: "cn",
                      url: `https://cn.example.com/${getManagedServerAssetName("1.2.3")}`
                    },
                    {
                      kind: "github",
                      label: "github",
                      primary: true,
                      url: `https://github.com/HagiCode-org/releases/releases/download/v1.2.3/${getManagedServerAssetName("1.2.3")}`
                    }
                  ]
                }
              ]
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("archive")
      } as Response)

    try {
      const result = await installManagedServer({
        manifestPath,
        runtimeRoot,
        indexUrl: "https://index.example.com/hagicode/index.json",
        indexChannel: "stable",
        downloadCache: false,
        ensurePm2: false,
        fetchImpl,
        installRuntimeFn,
        queryRuntimeStateFn,
        extractArchive: async (_archivePath, extractRoot) => {
          const libRoot = path.join(extractRoot, "package", "lib")
          await mkdir(libRoot, { recursive: true })
          await writeFile(path.join(libRoot, "PCode.Web.dll"), "dll", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.deps.json"), "deps", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.runtimeconfig.json"), "runtimeconfig", "utf8")
        }
      })

      expect(result.source.kind).toBe("http-index")
      expect(result.source.assetName).toBe(getManagedServerAssetName("1.2.3"))
      expect(result.source.version).toBe("1.2.3")
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        `https://github.com/HagiCode-org/releases/releases/download/v1.2.3/${getManagedServerAssetName("1.2.3")}`,
        expect.any(Object)
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("prefers manifest configured server activeVersion when no explicit version is provided", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-manifest-version-"))
    const manifestPath = path.join(directory, "manifest.yaml")
    const runtimeRoot = path.join(directory, "runtime-root")
    const scriptsDir = path.join(directory, "scripts")

    const installRuntimeFn = vi.fn(async () => ({
      manifest: {
        manifestPath,
        runtime: { name: "fixture-runtime", version: "1.0.0" }
      },
      paths: { root: runtimeRoot },
      state: {},
      plan: [{ componentName: "server", phase: "install", strategy: "script" }],
      skipped: [],
      changedComponents: ["server"],
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

    await mkdir(scriptsDir, { recursive: true })
    await Promise.all([
      writeFile(path.join(scriptsDir, "install-node.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "install-dotnet.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "install-server.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "configure-server.mjs"), "export {}\n", "utf8")
    ])

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
    installScript: "scripts/install-node.mjs"
  - name: "dotnet"
    type: "runtime"
    installScript: "scripts/install-dotnet.mjs"
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    lifecycleDependencies: ["node", "dotnet"]
    installScript: "scripts/install-server.mjs"
    configureScript: "scripts/configure-server.mjs"
    pm2:
      appName: "fixture-server"
      nameIdentifierEnv: "hagicode_instance"
      pm2Home: ".pm2"
    releasedService:
      dllPath: "lib/PCode.Web.dll"
      workingDirectory: "lib"
      runtimeFilesDir: "pm2-runtime"
      activeVersion: "2.4.6"
`,
      "utf8"
    )

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          versions: [
            {
              version: "2.4.6",
              channels: ["stable"],
              assets: [
                {
                  name: getManagedServerAssetName("2.4.6"),
                  downloadSources: [
                    {
                      kind: "github",
                      label: "github",
                      primary: true,
                      url: `https://github.com/HagiCode-org/releases/releases/download/v2.4.6/${getManagedServerAssetName("2.4.6")}`
                    }
                  ]
                }
              ]
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("archive")
      } as Response)

    try {
      const result = await installManagedServer({
        manifestPath,
        runtimeRoot,
        ensurePm2: false,
        downloadCache: false,
        fetchImpl,
        installRuntimeFn,
        queryRuntimeStateFn,
        extractArchive: async (_archivePath, extractRoot) => {
          const libRoot = path.join(extractRoot, "package", "lib")
          await mkdir(libRoot, { recursive: true })
          await writeFile(path.join(libRoot, "PCode.Web.dll"), "dll", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.deps.json"), "deps", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.runtimeconfig.json"), "runtimeconfig", "utf8")
        }
      })

      expect(result.source.kind).toBe("http-index")
      expect(result.source.version).toBe("2.4.6")
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        "https://index.hagicode.com/server/index.json",
        expect.any(Object)
      )
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        `https://github.com/HagiCode-org/releases/releases/download/v2.4.6/${getManagedServerAssetName("2.4.6")}`,
        expect.any(Object)
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("falls back to GitHub release when default HTTP index is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-index-fallback-"))
    const manifestPath = path.join(directory, "manifest.yaml")
    const runtimeRoot = path.join(directory, "runtime-root")
    const scriptsDir = path.join(directory, "scripts")

    const installRuntimeFn = vi.fn(async () => ({
      manifest: {
        manifestPath,
        runtime: { name: "fixture-runtime", version: "1.0.0" }
      },
      paths: { root: runtimeRoot },
      state: {},
      plan: [{ componentName: "server", phase: "install", strategy: "script" }],
      skipped: [],
      changedComponents: ["server"],
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

    await mkdir(scriptsDir, { recursive: true })
    await Promise.all([
      writeFile(path.join(scriptsDir, "install-node.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "install-dotnet.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "install-server.mjs"), "export {}\n", "utf8"),
      writeFile(path.join(scriptsDir, "configure-server.mjs"), "export {}\n", "utf8")
    ])

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
    installScript: "scripts/install-node.mjs"
  - name: "dotnet"
    type: "runtime"
    installScript: "scripts/install-dotnet.mjs"
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    lifecycleDependencies: ["node", "dotnet"]
    installScript: "scripts/install-server.mjs"
    configureScript: "scripts/configure-server.mjs"
    pm2:
      appName: "fixture-server"
      nameIdentifierEnv: "hagicode_instance"
      pm2Home: ".pm2"
    releasedService:
      dllPath: "lib/PCode.Web.dll"
      workingDirectory: "lib"
      runtimeFilesDir: "pm2-runtime"
`,
      "utf8"
    )

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({})
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v1.2.3",
           assets: [
            {
              name: getManagedServerAssetName("1.2.3"),
              browser_download_url:
                `https://github.com/HagiCode-org/releases/releases/download/v1.2.3/${getManagedServerAssetName("1.2.3")}`
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("archive")
      } as Response)

    try {
      const result = await installManagedServer({
        manifestPath,
        runtimeRoot,
        ensurePm2: false,
        fetchImpl,
        installRuntimeFn,
        queryRuntimeStateFn,
        extractArchive: async (_archivePath, extractRoot) => {
          const libRoot = path.join(extractRoot, "package", "lib")
          await mkdir(libRoot, { recursive: true })
          await writeFile(path.join(libRoot, "PCode.Web.dll"), "dll", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.deps.json"), "deps", "utf8")
          await writeFile(path.join(libRoot, "PCode.Web.runtimeconfig.json"), "runtimeconfig", "utf8")
        }
      })

      expect(result.source.kind).toBe("github-release")
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        "https://index.hagicode.com/server/index.json",
        expect.any(Object)
      )
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        "https://api.github.com/repos/HagiCode-org/releases/releases/latest",
        expect.any(Object)
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function getManagedServerAssetName(version: string): string {
  return `hagicode-${version}-${getManagedServerAssetSuffix()}`
}

function getManagedServerAssetSuffix(): string {
  return `${getManagedServerAssetPlatform()}-${getManagedServerAssetArchitecture()}-nort.zip`
}

function getManagedServerAssetPlatform(): "linux" | "win" | "osx" {
  switch (process.platform) {
    case "linux":
      return "linux"
    case "win32":
      return "win"
    case "darwin":
      return "osx"
    default:
      throw new Error(`Unsupported test platform: ${process.platform}`)
  }
}

function getManagedServerAssetArchitecture(): "x64" | "arm64" {
  switch (process.arch) {
    case "x64":
      return "x64"
    case "arm64":
      return "arm64"
    default:
      throw new Error(`Unsupported test architecture: ${process.arch}`)
  }
}
