import { access } from "node:fs/promises"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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

  it("plans filtered installs in manifest order", async () => {
    const manifest = await loadRuntimeManifest({ manifestPath: fixtureManifestPath })
    const state = createInitialRuntimeState(manifest, resolveRuntimePaths(manifest))
    const plan = planRuntimeLifecycle("install", manifest, state, {
      components: ["beta", "alpha"]
    })

    expect(plan.plan.map((item) => item.componentName)).toEqual(["alpha", "beta"])
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
    expect(report.components.map((item) => item.status)).toEqual([
      "installed",
      "installed"
    ])

    await rm(runtimeRoot, { recursive: true, force: true })
  })
})
