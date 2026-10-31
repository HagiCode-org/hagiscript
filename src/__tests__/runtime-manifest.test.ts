import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  loadRuntimeManifest,
  resolveRuntimeComponentPolicy,
  RuntimeManifestValidationError
} from "../runtime/runtime-manifest.js"
import {
  planRuntimeLifecycle,
  queryRuntimeState,
  shouldUseManagedNodeRuntime
} from "../runtime/runtime-manager.js"
import { resolveRuntimePaths } from "../runtime/runtime-paths.js"
import type { RuntimeState } from "../runtime/runtime-state.js"

const fixtureDirectory = path.resolve("tests/runtime/fixtures")
const fixtureManifestPath = path.join(fixtureDirectory, "runtime-manifest.yaml")
const packagedManifestPath = path.resolve("runtime/manifest.yaml")

function createEmptyRuntimeState(
  manifest: Awaited<ReturnType<typeof loadRuntimeManifest>>,
  runtimeRoot: string
): RuntimeState {
  const paths = resolveRuntimePaths(manifest, { runtimeRoot })
  return {
    schemaVersion: 1,
    runtime: {
      name: manifest.runtime.name,
      version: manifest.runtime.version,
      manifestPath: manifest.manifestPath
    },
    managedRoot: paths.root,
    managedPaths: paths,
    components: {},
    lastOperation: null
  }
}

function plannedNames(
  plan: { componentName: string }[]
): string[] {
  return plan.map((action) => action.componentName)
}

// Copies the packaged runtime and points its data root into `directory`, so state reads never touch the real home directory.
async function copyPackagedManifestInto(directory: string): Promise<string> {
  const runtimeDirectory = path.join(directory, "runtime")
  await cp(path.resolve("runtime"), runtimeDirectory, { recursive: true })
  const manifestPath = path.join(runtimeDirectory, "manifest.yaml")
  const manifest = (await readFile(manifestPath, "utf8")).replace(/\r\n/g, "\n")
  await writeFile(
    manifestPath,
    manifest.replace(
      /^ {2}runtimeDataRoot: .*$/m,
      `  runtimeDataRoot: "${path.join(directory, "runtime-data").replace(/\\/g, "/")}"`
    )
  )
  return manifestPath
}

async function copyFixtureManifest(): Promise<{
  directory: string
  manifestPath: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-runtime-manifest-"))
  await cp(fixtureDirectory, directory, { recursive: true })
  return {
    directory,
    manifestPath: path.join(directory, "runtime-manifest.yaml")
  }
}

describe("runtime manifest validation", () => {
  it("accepts an empty or omitted nodeRuntime while keeping dotnetRuntime required", async () => {
    const emptyNodeFixture = await copyFixtureManifest()
    const omittedNodeFixture = await copyFixtureManifest()
    const invalidDotnetFixture = await copyFixtureManifest()

    try {
      const fixture = (await readFile(fixtureManifestPath, "utf8")).replace(
        /\r\n/g,
        "\n"
      )
      await writeFile(
        emptyNodeFixture.manifestPath,
        fixture.replace('nodeRuntime: "components/node"', 'nodeRuntime: ""')
      )
      await writeFile(
        omittedNodeFixture.manifestPath,
        fixture.replace('  nodeRuntime: "components/node"\n', "")
      )
      await writeFile(
        invalidDotnetFixture.manifestPath,
        fixture.replace('dotnetRuntime: "components/dotnet"', 'dotnetRuntime: ""')
      )

      await expect(loadRuntimeManifest({ manifestPath: emptyNodeFixture.manifestPath }))
        .resolves.toMatchObject({ paths: { nodeRuntime: "" } })
      await expect(loadRuntimeManifest({ manifestPath: omittedNodeFixture.manifestPath }))
        .resolves.toMatchObject({ paths: { nodeRuntime: "" } })
      await expect(loadRuntimeManifest({ manifestPath: invalidDotnetFixture.manifestPath }))
        .rejects.toThrow(RuntimeManifestValidationError)
      await expect(loadRuntimeManifest({ manifestPath: invalidDotnetFixture.manifestPath }))
        .rejects.toThrow("paths.dotnetRuntime must be a non-empty string")
    } finally {
      await Promise.all([
        rm(emptyNodeFixture.directory, { recursive: true, force: true }),
        rm(omittedNodeFixture.directory, { recursive: true, force: true }),
        rm(invalidDotnetFixture.directory, { recursive: true, force: true })
      ])
    }
  })
})

describe("packaged runtime manifest with optional Node", () => {
  it("declares node as optional without an optional policy and keeps it out of server dependencies", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: packagedManifestPath })
    const node = manifest.componentMap.get("node")
    const server = manifest.componentMap.get("server")
    const codeServer = manifest.componentMap.get("code-server")

    expect(node?.required).toBe(false)
    expect(node?.optionalPolicy).toBeUndefined()
    expect(server?.lifecycleDependencies).not.toContain("node")
    expect(server?.lifecycleDependencies).toContain("dotnet")
    expect(codeServer?.lifecycleDependencies).toContain("node")
    expect(manifest.phases.install.order).toContain("node")
    expect(manifest.phases.update.order).toContain("node")
    expect(manifest.phases.remove.order).toContain("node")
  })

  it("plans no node in a default install and still plans dotnet and server", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: packagedManifestPath })
    const state = createEmptyRuntimeState(manifest, path.join(tmpdir(), "hagiscript-optional-node-plan"))
    const { plan } = planRuntimeLifecycle("install", manifest, state, {})

    expect(plannedNames(plan)).not.toContain("node")
    expect(plannedNames(plan)).toContain("dotnet")
    expect(plannedNames(plan)).toContain("server")
    expect(plannedNames(plan)).not.toContain("code-server")

    const removePlan = planRuntimeLifecycle("remove", manifest, state, {}).plan
    expect(plannedNames(removePlan)).toContain("node")
  })

  it("plans node on request and never as a skipped policy action", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: packagedManifestPath })
    const state = createEmptyRuntimeState(manifest, path.join(tmpdir(), "hagiscript-optional-node-plan"))
    const { plan } = planRuntimeLifecycle("install", manifest, state, { components: ["node"] })
    const nodeAction = plan.find((action) => action.componentName === "node")

    expect(nodeAction).toBeDefined()
    expect(nodeAction?.strategy).not.toBe("skipped-by-policy")
  })

  it("does not plan node for server but plans node before code-server", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: packagedManifestPath })
    const state = createEmptyRuntimeState(manifest, path.join(tmpdir(), "hagiscript-optional-node-plan"))

    const serverPlan = planRuntimeLifecycle("install", manifest, state, { components: ["server"] }).plan
    expect(plannedNames(serverPlan)).not.toContain("node")
    expect(plannedNames(serverPlan)).toContain("server")

    const codeServerPlan = planRuntimeLifecycle("install", manifest, state, { components: ["code-server"] }).plan
    const names = plannedNames(codeServerPlan)
    expect(names).toContain("node")
    expect(names.indexOf("node")).toBeLessThan(names.indexOf("code-server"))
  })

  it("keeps node out of the readiness set when it is not installed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-optional-node-state-"))
    try {
      const runtimeRoot = path.join(directory, "runtime-root")
      const manifestPath = await copyPackagedManifestInto(directory)
      const manifest = await loadRuntimeManifest({ manifestPath })
      const report = await queryRuntimeState({
        manifestPath,
        runtimeRoot
      })
      const node = report.components.find((component) => component.name === "node")

      expect(node?.status).toBe("not-installed")
      expect(node?.effectiveRequired).toBe(false)
      expect(report.components.filter((component) => component.effectiveRequired).map((component) => component.name))
        .not.toContain("node")
      expect(resolveRuntimeComponentPolicy(manifest.componentMap.get("node")!).required).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("uses managed Node only when it is installed or required", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: packagedManifestPath })
    const runtimeRoot = path.join(tmpdir(), "hagiscript-optional-node-managed")
    const state = createEmptyRuntimeState(manifest, runtimeRoot)

    expect(shouldUseManagedNodeRuntime(state, manifest)).toBe(false)

    const installedState: RuntimeState = {
      ...state,
      components: {
        node: {
          name: "node",
          type: "runtime",
          status: "installed",
          version: "22.22.2",
          managedProgramPaths: [],
          managedDataPaths: [],
          managedPaths: [],
          lastAction: "install",
          lastUpdatedAt: new Date(0).toISOString(),
          logFile: null
        }
      }
    }
    expect(shouldUseManagedNodeRuntime(installedState, manifest)).toBe(true)

    const skippedState: RuntimeState = {
      ...state,
      components: {
        node: { ...installedState.components.node, status: "skipped-by-policy" }
      }
    }
    expect(shouldUseManagedNodeRuntime(skippedState, manifest)).toBe(false)
  })
})
