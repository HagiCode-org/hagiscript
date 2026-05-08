import { access } from "node:fs/promises"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadRuntimeManifest } from "../runtime/runtime-manifest.js"
import {
  installRuntime,
  planRuntimeLifecycle,
  queryRuntimeState
} from "../runtime/runtime-manager.js"
import { createInitialRuntimeState } from "../runtime/runtime-state.js"
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
    order: ["node", "dotnet", "npm-packages", "server"]
  remove:
    order: ["server", "npm-packages", "dotnet", "node"]
  update:
    order: ["node", "dotnet", "npm-packages", "server"]
components:
  - name: "node"
    type: "runtime"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
  - name: "dotnet"
    type: "runtime"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
  - name: "npm-packages"
    type: "package"
    lifecycleDependencies: ["node"]
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
  - name: "server"
    type: "released-service"
    lifecycleDependencies: ["dotnet", "npm-packages"]
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "hagicode-server"
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

    expect(plan.plan.map((item) => item.componentName)).toEqual([
      "node",
      "dotnet",
      "npm-packages",
      "server"
    ])
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
      path.join(runtimeRoot, "program", "components"),
      path.join(runtimeRoot, "program", "npm")
    ])
    expect(report.layout.externalDataRoots).toEqual([
      path.join(runtimeRoot, "runtime-data"),
      path.join(runtimeRoot, "runtime-data", "config"),
      path.join(runtimeRoot, "runtime-data", "logs"),
      path.join(runtimeRoot, "runtime-data", "data"),
      path.join(runtimeRoot, "runtime-data", "components")
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

  it("reports released-service runtime state for managed server payloads", async () => {
    const setup = await createReleasedServiceRuntimeFixture()

    try {
      await installRuntime({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot
      })
      const report = await queryRuntimeState({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot
      })
      const server = report.components.find((item) => item.name === "server")

      expect(server?.status).toBe("installed")
      expect(server?.programPaths).toEqual([
        path.join(setup.runtimeRoot, "program", "components", "server")
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
      await installRuntime({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot
      })
      const report = await queryRuntimeState({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot
      })
      const server = report.components.find((item) => item.name === "server")

      expect(server?.status).toBe("installed")
      expect(server?.programPaths).toEqual([
        path.join(setup.runtimeRoot, "program", "components", "server")
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
