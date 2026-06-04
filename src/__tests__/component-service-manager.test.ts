import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  executeComponentServiceAction,
  renderComponentServiceResultText,
  resolveComponentServiceDefinition
} from "../runtime/component-service-manager.js"
import { resolveRuntimePaths } from "../runtime/runtime-paths.js"
import type { LoadedRuntimeManifest } from "../runtime/runtime-manifest.js"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("component service manager", () => {
  it("maps code_server to the managed code-server service", () => {
    expect(resolveComponentServiceDefinition("code_server").service).toBe("code-server")
    expect(resolveComponentServiceDefinition("omniroute").service).toBe("omniroute")
  })

  it("delegates lifecycle actions to the managed PM2 contract using the extracted runtime root", async () => {
    const runtimeRoot = await makeRuntimeRoot("component-pm2-start")
    const manifest = createManifest()
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    await seedPackagedArchiveState(paths, "omniroute", "3.6.9")
    const exactResult = await runExact(runtimeRoot, manifest, "omniroute")
    const runManagedPm2Command = vi.fn(async () => ({
      service: "omniroute",
      action: "start",
      baseAppName: "hagicode-omniroute",
      appName: "hagicode-omniroute-hagicode",
      nameIdentifierEnv: "hagicode_instance",
      nameIdentifier: "hagicode",
      cwd: exactResult.currentRoot,
      script: path.join(exactResult.currentRoot, "bin", "omniroute.mjs"),
      runtimeHome: paths.runtimeHome,
      runtimeDataHome: path.join(paths.runtimeDataRoot, "components", "services", "omniroute"),
      pm2Home: path.join(paths.runtimeDataRoot, "components", "services", "omniroute", "pm2"),
      pm2Binary: path.join(paths.npmPrefix, "bin", "pm2"),
      exists: true,
      status: "online",
      pid: 4242,
      stdout: "[]",
      stderr: "",
      launchStrategy: "node-script" as const
    }))

    const result = await executeComponentServiceAction(
      "omniroute",
      "start",
      { runtimeRoot },
      {
        loadRuntimeManifest: async () => manifest,
        resolveRuntimePaths,
        runManagedPm2Command
      }
    )

    expect(runManagedPm2Command).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRoot,
        service: "omniroute",
        action: "start",
        componentRootOverride: exactResult.extractedRuntimeRoot
      })
    )
    expect(result).toMatchObject({
      component: "omniroute",
      service: "omniroute",
      action: "start",
      ok: true
    })
  })

  it("delegates env actions to the managed PM2 environment contract", async () => {
    const runtimeRoot = await makeRuntimeRoot("component-pm2-env")
    const manifest = createManifest()
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    await seedPackagedArchiveState(paths, "code-server", "4.117.0")
    const exactResult = await runExact(runtimeRoot, manifest, "code_server")
    const resolveManagedPm2Environment = vi.fn(async () => ({
      service: "code-server",
      baseAppName: "hagicode-code-server",
      appName: "hagicode-code-server-hagicode",
      nameIdentifierEnv: "hagicode_instance",
      nameIdentifier: "hagicode",
      bootstrapNameIdentifierValue: "hagicode",
      cwd: exactResult.currentRoot,
      script: path.join(exactResult.currentRoot, "out", "node", "entry.js"),
      args: ["--config", path.join(paths.runtimeDataRoot, "components", "services", "code-server", "config", "config.yaml")],
      env: { HAGICODE_RUNTIME_HOME: paths.runtimeHome },
      pathKey: "PATH" as const,
      pathEntries: [path.join(paths.npmPrefix, "bin")],
      runtimeHome: paths.runtimeHome,
      runtimeDataHome: path.join(paths.runtimeDataRoot, "components", "services", "code-server"),
      componentRoot: exactResult.extractedRuntimeRoot,
      componentConfigDir: path.join(paths.runtimeDataRoot, "components", "services", "code-server", "config"),
      pm2Home: path.join(paths.runtimeDataRoot, "components", "services", "code-server", "pm2"),
      pm2Binary: path.join(paths.npmPrefix, "bin", "pm2"),
      nodePath: path.join(paths.nodeRuntime, "current", "bin", "node"),
      useManagedNodeRuntime: true,
      launchStrategy: "node-script" as const
    }))

    const result = await executeComponentServiceAction(
      "code_server",
      "env",
      { runtimeRoot },
      {
        loadRuntimeManifest: async () => manifest,
        resolveRuntimePaths,
        resolveManagedPm2Environment
      }
    )

    expect(resolveManagedPm2Environment).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRoot,
        service: "code-server",
        componentRootOverride: exactResult.extractedRuntimeRoot
      })
    )
    expect(renderComponentServiceResultText(result)).toContain("Component: code_server")
  })

  it("extracts a packaged 7z runtime into runtime-data/runtimeComponents/<component>/<version>", async () => {
    const runtimeRoot = await makeRuntimeRoot("component-exact")
    const manifest = createManifest()
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    await seedPackagedArchiveState(paths, "omniroute", "3.6.9")

    const result = await runExact(runtimeRoot, manifest, "omniroute")
    const entrypointPath = path.join(result.currentRoot, "bin", "omniroute.mjs")
    const statePath = path.join(
      paths.runtimeDataRoot,
      "components",
      "services",
      "omniroute",
      "extracted-runtime.json"
    )

    expect(result.extractedRuntimeRoot).toBe(
      path.join(paths.runtimeDataRoot, "runtimeComponents", "omniroute", "3.6.9")
    )
    await expect(readFile(entrypointPath, "utf8")).resolves.toContain("omniroute")
    const state = JSON.parse(await readFile(statePath, "utf8"))
    expect(state.versionedRoot).toBe(result.extractedRuntimeRoot)
  })

  it("fails exact with an actionable error when runtime assets are missing", async () => {
    const runtimeRoot = await makeRuntimeRoot("component-exact-missing")
    const manifest = createManifest()

    await expect(
      executeComponentServiceAction(
        "code_server",
        "exact",
        { runtimeRoot },
        {
          loadRuntimeManifest: async () => manifest,
          resolveRuntimePaths
        }
      )
    ).rejects.toThrow("Run `hagiscript runtime install` first")
  })

  it("surfaces actionable failures when the extraction provider is unavailable", async () => {
    const runtimeRoot = await makeRuntimeRoot("component-exact-provider")
    const manifest = createManifest()
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    await seedPackagedArchiveState(paths, "code-server", "4.117.0")

    await expect(
      executeComponentServiceAction(
        "code_server",
        "exact",
        { runtimeRoot },
        {
          loadRuntimeManifest: async () => manifest,
          resolveRuntimePaths,
          createSevenZipExtractor: () => {
            throw new Error("Bundled extraction provider unavailable for code-server")
          }
        }
      )
    ).rejects.toThrow("Bundled extraction provider unavailable for code-server")
  })

  it("returns successful empty log envelopes when allowlisted log files are missing", async () => {
    const runtimeRoot = await makeRuntimeRoot("component-logs-empty")
    const manifest = createManifest()
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    await seedPackagedArchiveState(paths, "code-server", "4.117.0")
    await runExact(runtimeRoot, manifest, "code_server")

    const result = await executeComponentServiceAction(
      "code_server",
      "logs",
      { runtimeRoot, lines: 50 },
      {
        loadRuntimeManifest: async () => manifest,
        resolveRuntimePaths
      }
    )

    expect(result).toMatchObject({
      component: "code_server",
      service: "code-server",
      action: "logs",
      ok: true,
      requestedLines: 50,
      lines: []
    })
    expect(result.targetPath).toBe(
      path.join(paths.runtimeDataRoot, "components", "services", "code-server", "logs", "code-server.log")
    )
  })

  it("returns recent log lines from allowlisted managed log targets", async () => {
    const runtimeRoot = await makeRuntimeRoot("component-logs-lines")
    const manifest = createManifest()
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    await seedPackagedArchiveState(paths, "omniroute", "3.6.9")
    await runExact(runtimeRoot, manifest, "omniroute")
    const logPath = path.join(paths.runtimeDataRoot, "components", "services", "omniroute", "logs", "omniroute.log")
    await mkdir(path.dirname(logPath), { recursive: true })
    await writeFile(logPath, "line-1\nline-2\nline-3\n", "utf8")

    const result = await executeComponentServiceAction(
      "omniroute",
      "logs",
      { runtimeRoot, lines: 2 },
      {
        loadRuntimeManifest: async () => manifest,
        resolveRuntimePaths
      }
    )

    expect(result.lines).toEqual(["line-2", "line-3"])
  })
})

async function makeRuntimeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `hagiscript-${prefix}-`))
  tempRoots.push(root)
  return root
}

function createManifest(): LoadedRuntimeManifest {
  const nodeComponent = {
    name: "node",
    type: "runtime",
    required: true,
    bundledInstallMode: "extract",
    lifecycleDependencies: [],
    packageCatalog: [],
    scripts: { install: "/tmp/install-node.mjs" }
  } satisfies RuntimeComponentDefinitionLike
  const omnirouteComponent = {
    name: "omniroute",
    type: "bundled-runtime",
    required: false,
    version: "3.6.9",
    bundledInstallMode: "archive-7z-only",
    runtimeDataDir: "services/omniroute",
    lifecycleDependencies: ["node"],
    packageCatalog: [],
    pm2: {
      appName: "hagicode-omniroute",
      cwd: "current"
    },
    scripts: { install: "/tmp/install-omniroute.mjs" }
  } satisfies RuntimeComponentDefinitionLike
  const codeServerComponent = {
    name: "code-server",
    type: "bundled-runtime",
    required: true,
    version: "4.117.0",
    bundledInstallMode: "archive-7z-only",
    runtimeDataDir: "services/code-server",
    lifecycleDependencies: ["node"],
    packageCatalog: [],
    pm2: {
      appName: "hagicode-code-server",
      cwd: "current"
    },
    scripts: { install: "/tmp/install-code-server.mjs" }
  } satisfies RuntimeComponentDefinitionLike

  const components = [nodeComponent, omnirouteComponent, codeServerComponent]

  return {
    manifestPath: "/fixtures/runtime-manifest.yaml",
    manifestDir: "/fixtures",
    runtime: {
      name: "fixture-runtime",
      version: "1.0.0",
      hagicodeInstance: "hagicode"
    },
    components,
    componentMap: new Map(components.map((component) => [component.name, component])),
    phases: {
      install: { order: ["node", "omniroute", "code-server"], reverse: false },
      remove: { order: ["code-server", "omniroute", "node"], reverse: false },
      update: { order: ["node", "omniroute", "code-server"], reverse: false }
    },
    paths: {
      runtimeRoot: "~/.hagicode/runtime",
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
      vendoredRoot: "components/bundled"
    }
  }
}

type RuntimeComponentDefinitionLike = LoadedRuntimeManifest["components"][number]

async function seedPackagedArchiveState(
  paths: ResolvedRuntimePathsLike,
  componentName: "omniroute" | "code-server",
  version: string
): Promise<void> {
  const packagedRoot = path.join(paths.runtimeHome, "components", "bundled", componentName)
  const archivePath = path.join(packagedRoot, "archives", `${componentName}.7z`)
  await mkdir(path.dirname(archivePath), { recursive: true })
  await writeFile(archivePath, `${componentName}-archive`, "utf8")
  await writeFile(
    path.join(packagedRoot, ".hagicode-runtime.json"),
    `${JSON.stringify({ version, archivePath, archiveFormat: "7z" }, null, 2)}\n`,
    "utf8"
  )
}

async function runExact(
  runtimeRoot: string,
  manifest: LoadedRuntimeManifest,
  component: "omniroute" | "code_server"
) {
  return executeComponentServiceAction(
    component,
    "exact",
    { runtimeRoot },
    {
      loadRuntimeManifest: async () => manifest,
      resolveRuntimePaths,
      createSevenZipExtractor: () => ({
        binaryPath: "/bundled/7za",
        extract: async (_archivePath, destination) => {
          const relativeEntrypoint =
            component === "code_server"
              ? path.join("payload", "out", "node", "entry.js")
              : path.join("payload", "bin", "omniroute.mjs")
          const entrypointPath = path.join(destination, relativeEntrypoint)
          await mkdir(path.dirname(entrypointPath), { recursive: true })
          await writeFile(entrypointPath, `// ${component} entrypoint\n`, "utf8")
        }
      })
    }
  )
}

type ResolvedRuntimePathsLike = ReturnType<typeof resolveRuntimePaths>
