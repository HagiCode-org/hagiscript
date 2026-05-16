import { access } from "node:fs/promises"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import * as pm2ManagerModule from "../runtime/pm2-manager.js"
import { loadRuntimeManifest } from "../runtime/runtime-manifest.js"
import {
  installRuntime,
  removeRuntime,
  planRuntimeLifecycle,
  queryRuntimeState
} from "../runtime/runtime-manager.js"
import { createInitialRuntimeState, writeRuntimeState } from "../runtime/runtime-state.js"
import { resolveRuntimePaths } from "../runtime/runtime-paths.js"

const fixtureManifestPath = path.resolve(
  fileURLToPath(
    new URL("../../tests/runtime/fixtures/runtime-manifest.yaml", import.meta.url)
  )
)
const fixtureScriptPath = path.resolve(
  fileURLToPath(
    new URL("../../tests/runtime/fixtures/scripts/install-component.mjs", import.meta.url)
  )
)
const fixtureFailureManifestPath = path.resolve(
  fileURLToPath(
    new URL("../../tests/runtime/fixtures/runtime-manifest-failure.yaml", import.meta.url)
  )
)

describe("runtime manager", () => {
  it("rejects manifests with missing required sections", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-invalid-"))
    const manifestPath = path.join(directory, "invalid.yaml")

    await writeFile(
      manifestPath,
      "runtime:\n  name: invalid\n  version: 1.0.0\n",
      "utf8"
    )

    await expect(loadRuntimeManifest({ manifestPath })).rejects.toThrow(
      /components must be an array/
    )
    await rm(directory, { recursive: true, force: true })
  })

  it("rejects invalid PM2 env overrides in the runtime manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-invalid-pm2-"))
    const manifestPath = path.join(directory, "invalid-pm2.yaml")

    await writeFile(
      manifestPath,
        `runtime:
  name: invalid
  version: 1.0.0
paths:
  runtimeRoot: "~/.hagicode/runtime"
  bin: "bin"
  config: "config"
  logs: "logs"
  data: "data"
  stateFile: "state.json"
  componentsRoot: "components"
  npmPrefix: "npm"
  nodeRuntime: "components/node"
  dotnetRuntime: "components/dotnet"
  vendoredRoot: "components/services"
phases:
  install:
    order: ["omniroute"]
  remove:
    order: ["omniroute"]
  update:
    order: ["omniroute"]
components:
  - name: "omniroute"
    type: "bundled-runtime"
    installScript: "scripts/install-component.mjs"
    pm2:
      env:
        PORT: 39001
`,
      "utf8"
    )

    await expect(loadRuntimeManifest({ manifestPath })).rejects.toThrow(/pm2.env.PORT must be a string/)
    await rm(directory, { recursive: true, force: true })
  })

  it("loads optional embedded npmSync configuration from the runtime manifest", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: fixtureManifestPath })

    expect(manifest.npmSync).toEqual({
      packages: {
        "@anthropic-ai/claude-code": {
          version: "2.1.119",
          target: "2.1.119"
        },
        "@fission-ai/openspec": {
          version: "1.3.1",
          target: "1.3.1"
        },
        "@openai/codex": {
          version: "0.125.0",
          target: "0.125.0"
        },
        skills: {
          version: "1.5.1",
          target: "1.5.1"
        }
      }
    })
  })

  it("rejects PM2 manifests without a required naming env declaration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-invalid-pm2-name-"))
    const manifestPath = path.join(directory, "invalid-pm2-name.yaml")

    await writeFile(
      manifestPath,
      `runtime:
  name: invalid
  version: 1.0.0
paths:
  runtimeRoot: "~/.hagicode/runtime"
  bin: "bin"
  config: "config"
  logs: "logs"
  data: "data"
  stateFile: "state.json"
  componentsRoot: "components"
  npmPrefix: "npm"
  nodeRuntime: "components/node"
  dotnetRuntime: "components/dotnet"
  vendoredRoot: "components/services"
phases:
  install:
    order: ["server"]
  remove:
    order: ["server"]
  update:
    order: ["server"]
components:
  - name: "server"
    type: "released-service"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "hagicode-server"
    releasedService:
      dllPath: "current/lib/PCode.Web.dll"
      workingDirectory: "current/lib"
`,
      "utf8"
    )

    await expect(loadRuntimeManifest({ manifestPath })).resolves.toBeDefined()
    await rm(directory, { recursive: true, force: true })
  })

  it("rejects manifests with invalid runtime hagicodeInstance", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-invalid-instance-format-"))
    const manifestPath = path.join(directory, "invalid-instance-format.yaml")

    await writeFile(
      manifestPath,
      `runtime:
  name: invalid
  version: 1.0.0
  hagicodeInstance: "Invalid-Instance"
paths:
  runtimeRoot: "~/.hagicode/runtime"
  bin: "bin"
  config: "config"
  logs: "logs"
  data: "data"
  stateFile: "state.json"
  componentsRoot: "components"
  npmPrefix: "npm"
  nodeRuntime: "components/node"
  dotnetRuntime: "components/dotnet"
  vendoredRoot: "components/services"
phases:
  install:
    order: ["server"]
  remove:
    order: ["server"]
  update:
    order: ["server"]
components:
  - name: "server"
    type: "released-service"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "hagicode-server"
    releasedService:
      dllPath: "current/lib/PCode.Web.dll"
      workingDirectory: "current/lib"
`,
      "utf8"
    )

    await expect(loadRuntimeManifest({ manifestPath })).rejects.toThrow(
      /runtime\.hagicodeInstance must match \^\[a-z0-9_\]\+\$/
    )
    await rm(directory, { recursive: true, force: true })
  })

  it("rejects released-service components without required launch metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-invalid-server-"))
    const manifestPath = path.join(directory, "invalid-server.yaml")

    await writeFile(
      manifestPath,
      `runtime:
  name: invalid
  version: 1.0.0
paths:
  runtimeRoot: "~/.hagicode/runtime"
  bin: "bin"
  config: "config"
  logs: "logs"
  data: "data"
  stateFile: "state.json"
  componentsRoot: "components"
  npmPrefix: "npm"
  nodeRuntime: "components/node"
  dotnetRuntime: "components/dotnet"
  vendoredRoot: "components/services"
phases:
  install:
    order: ["server"]
  remove:
    order: ["server"]
  update:
    order: ["server"]
components:
  - name: "server"
    type: "released-service"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "hagicode-server"
      nameIdentifierEnv: "hagicode_pm2_name"
    releasedService:
      workingDirectory: "current/lib"
`,
      "utf8"
    )

    await expect(loadRuntimeManifest({ manifestPath })).rejects.toThrow(
      /releasedService\.dllPath must be a non-empty string/
    )
    await rm(directory, { recursive: true, force: true })
  })

  it("plans filtered installs in manifest order", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: fixtureManifestPath })
    const state = createInitialRuntimeState(manifest, resolveRuntimePaths(manifest))
    const plan = planRuntimeLifecycle("install", manifest, state, {
      components: ["beta", "alpha"]
    })

    expect(plan.plan.map((item) => item.componentName)).toEqual(["alpha", "beta"])
  })

  it("expands lifecycle dependencies for released-service installs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-deps-"))
    const manifestPath = path.join(directory, "deps.yaml")

    await writeFile(
      manifestPath,
        `runtime:
  name: fixture-runtime
  version: 1.0.0
paths:
  runtimeRoot: "~/.hagicode/runtime"
  bin: "bin"
  config: "config"
  logs: "logs"
  data: "data"
  stateFile: "state.json"
  componentsRoot: "components"
  npmPrefix: "npm"
  nodeRuntime: "components/node"
  dotnetRuntime: "components/dotnet"
  vendoredRoot: "components/services"
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
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
  - name: "dotnet"
    type: "runtime"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
  - name: "server"
    type: "released-service"
    lifecycleDependencies: ["node", "dotnet"]
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "hagicode-server"
      nameIdentifierEnv: "hagicode_pm2_name"
    releasedService:
      dllPath: "current/lib/PCode.Web.dll"
      workingDirectory: "current/lib"
`,
      "utf8"
    )

    const manifest = await loadRuntimeManifest({ manifestPath })
    const state = createInitialRuntimeState(manifest, resolveRuntimePaths(manifest))
    const plan = planRuntimeLifecycle("install", manifest, state, {
      components: ["server"]
    })

    expect(plan.plan.map((item) => item.componentName)).toEqual(["node", "dotnet", "server"])
    await rm(directory, { recursive: true, force: true })
  })

  it("does not write state during dry-run execution", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-dryrun-"))

    await installRuntime({
      manifestPath: fixtureManifestPath,
      runtimeRoot,
      dryRun: true
    })

    await expect(access(path.join(runtimeRoot, "state.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    await rm(runtimeRoot, { recursive: true, force: true })
  })

  it("writes state and reports installed components", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-state-"))

    await installRuntime({
      manifestPath: fixtureManifestPath,
      runtimeRoot
    })
    const report = await queryRuntimeState({
      manifestPath: fixtureManifestPath,
      runtimeRoot
    })

    expect(report.ready).toBe(true)
    expect(report.layout.separated).toBe(true)
    expect(report.layout.runtimeHome).toBe(path.join(runtimeRoot, "program"))
    expect(report.layout.runtimeDataRoot).toBe(path.join(runtimeRoot, "runtime-data"))
    expect(report.layout.programRoots).toEqual([
      path.join(runtimeRoot, "program"),
      path.join(runtimeRoot, "program", "bin"),
      path.join(runtimeRoot, "program", "components")
    ])
    expect(report.layout.externalDataRoots).toEqual([
      path.join(runtimeRoot, "runtime-data"),
      path.join(runtimeRoot, "runtime-data", "config"),
      path.join(runtimeRoot, "runtime-data", "logs"),
      path.join(runtimeRoot, "runtime-data", "data"),
      path.join(runtimeRoot, "runtime-data", "components"),
      path.join(runtimeRoot, "runtime-data", "npm")
    ])
    expect(report.components.map((item) => item.status)).toEqual([
      "installed",
      "installed"
    ])
    expect(report.components[0]?.programPaths[0]).toContain(
      path.join(runtimeRoot, "program", "components")
    )
    expect(report.components[0]?.runtimeDataHome).toBe(
      path.join(runtimeRoot, "runtime-data", "components", "alpha-data")
    )
    expect(report.components[0]?.externalDataPaths[0]).toContain(
      path.join(runtimeRoot, "runtime-data", "components", "alpha-data")
    )

    await rm(runtimeRoot, { recursive: true, force: true })
  })

  it("stops and deletes pm2-managed bundled runtimes during remove", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-remove-pm2-"))
    const runtimeRoot = path.join(directory, "runtime-root")
    const manifestPath = path.join(directory, "manifest.yaml")
    const pm2Spy = vi
      .spyOn(pm2ManagerModule, "runManagedPm2Command")
      .mockResolvedValue({
        service: "omniroute",
        action: "stop",
        baseAppName: "hagicode-omniroute",
        appName: "hagicode-omniroute-test",
        nameIdentifierEnv: "hagicode_instance",
        nameIdentifier: "test",
        cwd: runtimeRoot,
        script: "launcher.mjs",
        runtimeHome: runtimeRoot,
        runtimeDataHome: runtimeRoot,
        pm2Home: runtimeRoot,
        pm2Binary: "pm2",
        exists: false,
        status: "missing",
        pid: null,
        stdout: "[]",
        stderr: "",
        launchStrategy: "node-script"
      })

    try {
      await writeFile(
        manifestPath,
        `runtime:
  name: fixture-runtime
  version: 1.0.0
paths:
  runtimeRoot: "~/.hagicode/runtime"
  runtimeHome: "program"
  runtimeDataRoot: "runtime-data"
  serverProgramRoot: "server"
  serverDataRoot: "server-data"
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
    order: ["omniroute"]
  remove:
    order: ["omniroute"]
  update:
    order: ["omniroute"]
components:
  - name: "omniroute"
    type: "bundled-runtime"
    runtimeDataDir: "services/omniroute"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    removeScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "hagicode-omniroute"
      script: "current/omniroute-launcher.mjs"
`,
        "utf8"
      )

      await mkdir(path.join(directory, "templates"), { recursive: true })
      await writeFile(
        path.join(directory, "templates", "service-template.txt"),
        "component={{COMPONENT_NAME}} root={{RUNTIME_ROOT}} phase={{PHASE}}\n",
        "utf8"
      )

      await mkdir(runtimeRoot, { recursive: true })
      await removeRuntime({ manifestPath, runtimeRoot })

      expect(pm2Spy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          manifestPath,
          runtimeRoot,
          service: "omniroute",
          action: "stop"
        })
      )
      expect(pm2Spy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          manifestPath,
          runtimeRoot,
          service: "omniroute",
          action: "delete"
        })
      )
    } finally {
      pm2Spy.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("surfaces script stderr and runtime log paths when a component install fails", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-failure-"))

    try {
      await installRuntime({
        manifestPath: fixtureFailureManifestPath,
        runtimeRoot
      })
      throw new Error("Expected runtime install to fail.")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain("install failed for component failer")
      expect(message).toContain("intentional failure for failer")
      const logPathMatch = message.match(/Log: (.+)$/m)
      expect(logPathMatch?.[1]).toBeTruthy()

      const logContents = await readFile(String(logPathMatch?.[1]), "utf8")
      expect(logContents).toContain("# install:failer")
      expect(logContents).toContain("stderr:\nintentional failure for failer")
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })

  it("reports released-service runtime state for managed server payloads", async () => {
    const setup = await createReleasedServiceRuntimeFixture()

    try {
      await seedReleasedServiceRuntimeState(setup)
      const report = await queryRuntimeState({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot
      })
      const server = report.components.find((item) => item.name === "server")

      expect(server?.status).toBe("installed")
      expect(server?.programPaths).toEqual([
        path.join(setup.runtimeRoot, "program", "server")
      ])
      expect(server?.externalDataPaths).toContain(
        path.join(setup.runtimeRoot, "runtime-data", "components", "services", "server")
      )
      expect(server?.details).toMatchObject({
        releasedPayloadPath: setup.releasedPayloadPath,
        releasedWorkingDirectory: setup.releasedWorkingDirectory,
        launchAssetsDirectory: path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "server",
          "pm2-runtime"
        ),
        releasedServiceReady: true
      })
    } finally {
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("reports released-service runtime state for external server payloads", async () => {
    const setup = await createReleasedServiceRuntimeFixture({ serviceLocation: "external" })

    try {
      await seedReleasedServiceRuntimeState(setup)
      const report = await queryRuntimeState({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot
      })
      const server = report.components.find((item) => item.name === "server")

      expect(server?.status).toBe("installed")
      expect(server?.programPaths).toEqual([
        path.join(setup.runtimeRoot, "program", "server")
      ])
      expect(server?.externalDataPaths).toContain(
        path.join(setup.runtimeRoot, "runtime-data", "components", "services", "server")
      )
      expect(server?.details).toMatchObject({
        releasedPayloadPath: setup.releasedPayloadPath,
        releasedWorkingDirectory: setup.releasedWorkingDirectory,
        launchAssetsDirectory: path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "server",
          "pm2-runtime"
        ),
        releasedServiceReady: true
      })
    } finally {
      await rm(setup.directory, { recursive: true, force: true })
    }
  })
})

async function createReleasedServiceRuntimeFixture(options: {
  serviceLocation?: "managed" | "external"
} = {}): Promise<{
  directory: string
  manifestPath: string
  runtimeRoot: string
  releasedPayloadPath: string
  releasedWorkingDirectory: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-server-"))
  const runtimeRoot = path.join(directory, "managed-runtime")
  const manifestPath = path.join(directory, "released-service.yaml")
  const templateDir = path.join(directory, "templates")
  const releasedWorkingDirectory =
    options.serviceLocation === "external"
      ? path.join(directory, "external-local-publishment", "lib")
      : path.join(runtimeRoot, "program", "components", "server", "current", "lib")
  const releasedPayloadPath = path.join(releasedWorkingDirectory, "PCode.Web.dll")

  await mkdir(releasedWorkingDirectory, { recursive: true })
  await mkdir(templateDir, { recursive: true })
  await writeFile(releasedPayloadPath, "fixture released-service payload\n", "utf8")
  await writeFile(
    path.join(templateDir, "service-template.txt"),
    "component={{COMPONENT_NAME}} root={{RUNTIME_ROOT}} phase={{PHASE}}\n",
    "utf8"
  )
  await writeFile(
    manifestPath,
    `runtime:
  name: fixture-runtime
  version: 1.0.0
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
  nodeRuntime: "components/node"
  dotnetRuntime: "components/dotnet"
  vendoredRoot: "components/services"
phases:
  install:
    order: ["server"]
  remove:
    order: ["server"]
  update:
    order: ["server"]
components:
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "hagicode-server"
    releasedService:
      dllPath: "${
        options.serviceLocation === "external"
          ? normalizeManifestPath(releasedPayloadPath)
          : "current/lib/PCode.Web.dll"
      }"
      workingDirectory: "${
        options.serviceLocation === "external"
          ? normalizeManifestPath(releasedWorkingDirectory)
          : "current/lib"
      }"
      configRoot: "${
        options.serviceLocation === "external"
          ? normalizeManifestPath(releasedWorkingDirectory)
          : "current/lib"
      }"
      runtimeFilesDir: "pm2-runtime"
`,
    "utf8"
  )

  return {
    directory,
    manifestPath,
    runtimeRoot,
    releasedPayloadPath,
    releasedWorkingDirectory
  }
}

function normalizeManifestPath(value: string): string {
  return value.replaceAll("\\", "/")
}

async function seedReleasedServiceRuntimeState(setup: {
  manifestPath: string
  runtimeRoot: string
  releasedPayloadPath: string
  releasedWorkingDirectory: string
}): Promise<void> {
  const manifest = await loadRuntimeManifest({ manifestPath: setup.manifestPath })
  const paths = resolveRuntimePaths(manifest, { runtimeRoot: setup.runtimeRoot })
  const state = createInitialRuntimeState(manifest, paths)

  state.components.server = {
    name: "server",
    type: "released-service",
    status: "installed",
    version: null,
    managedProgramPaths: [paths.serverProgramRoot],
    managedDataPaths: [path.join(paths.componentDataRoot, "services", "server")],
    managedPaths: [
      paths.serverProgramRoot,
      path.join(paths.componentDataRoot, "services", "server")
    ],
    lastAction: "install",
    lastUpdatedAt: new Date().toISOString(),
    logFile: null,
    details: {
      releasedPayloadPath: setup.releasedPayloadPath,
      releasedWorkingDirectory: setup.releasedWorkingDirectory,
      launchAssetsDirectory: path.join(
        setup.runtimeRoot,
        "runtime-data",
        "components",
        "services",
        "server",
        "pm2-runtime"
      ),
      releasedServiceReady: true
    }
  }

  await writeRuntimeState(paths.stateFile, state)
}
