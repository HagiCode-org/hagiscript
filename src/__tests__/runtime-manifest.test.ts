import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { loadRuntimeManifest, RuntimeManifestValidationError } from "../runtime/runtime-manifest.js"

const fixtureDirectory = path.resolve("tests/runtime/fixtures")
const fixtureManifestPath = path.join(fixtureDirectory, "runtime-manifest.yaml")

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
      const fixture = await readFile(fixtureManifestPath, "utf8")
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
