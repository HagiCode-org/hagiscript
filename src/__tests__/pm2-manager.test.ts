import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import process from "node:process"
import { describe, expect, it } from "vitest"
import {
  resolveManagedPm2ServiceDefinition
} from "../runtime/pm2-manager.js"
import { loadRuntimeManifest } from "../runtime/runtime-manifest.js"
import { getManagedServerVersionStatePath } from "../runtime/server-version-state.js"
import { resolveRuntimePaths } from "../runtime/runtime-paths.js"

const packagedRuntimeDirectory = path.resolve("runtime")

async function setUpNodeLessReleasedServiceFixture(directory: string): Promise<{
  loadedManifest: Awaited<ReturnType<typeof loadRuntimeManifest>>
  paths: ReturnType<typeof resolveRuntimePaths>
}> {
  const runtimeDirectory = path.join(directory, "runtime")
  const runtimeRoot = path.join(directory, "runtime-root")
  const manifestPath = path.join(runtimeDirectory, "manifest.yaml")
  const serverInstallPath = path.join(runtimeRoot, "server", "versions", "1.0.0")

  await cp(packagedRuntimeDirectory, runtimeDirectory, { recursive: true })
  const manifest = (await readFile(manifestPath, "utf8")).replace(
    /\r\n/g,
    "\n"
  )
  await writeFile(
    manifestPath,
    manifest
      .replace('  nodeRuntime: "components/node/runtime"\n', "")
      .replace(
        '- name: "node"\n  type: "runtime"',
        '- name: "node"\n  type: "runtime"\n  required: false'
      )
      .replace(/^\s*startScript: "start\.sh"\n/m, "")
  )

  const loadedManifest = await loadRuntimeManifest({ manifestPath })
  const paths = resolveRuntimePaths(loadedManifest, {
    runtimeRoot,
    runtimeDataRoot: path.join(runtimeRoot, "runtime-data")
  })
  const pm2BinDirectory =
    process.platform === "win32"
      ? path.join(paths.npmPrefix, "node_modules", "pm2", "bin")
      : path.join(paths.npmPrefix, "lib", "node_modules", "pm2", "bin")
  await Promise.all([
    mkdir(pm2BinDirectory, { recursive: true }),
    mkdir(path.join(serverInstallPath, "lib"), { recursive: true }),
    mkdir(path.join(paths.dotnetRuntime, "current"), { recursive: true }),
    mkdir(path.dirname(getManagedServerVersionStatePath(paths)), { recursive: true })
  ])
  await Promise.all([
    writeFile(
      path.join(pm2BinDirectory, "pm2"),
      ""
    ),
    writeFile(path.join(serverInstallPath, "lib", "PCode.Web.dll"), ""),
    writeFile(
      path.join(
        paths.dotnetRuntime,
        "current",
        process.platform === "win32" ? "dotnet.exe" : "dotnet"
      ),
      ""
    ),
    writeFile(
      getManagedServerVersionStatePath(paths),
      JSON.stringify({
        schemaVersion: 1,
        activeVersion: "1.0.0",
        versions: {
          "1.0.0": {
            version: "1.0.0",
            installPath: serverInstallPath,
            installedAt: new Date(0).toISOString(),
            source: {
              kind: "local-folder",
              locator: serverInstallPath,
              assetName: "server"
            }
          }
        }
      })
    )
  ])

  return { loadedManifest, paths }
}

describe("managed PM2 service resolution", () => {
  it("falls back to an external Node executable for a node-less released service", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-pm2-node-less-"))

    try {
      const { loadedManifest, paths } = await setUpNodeLessReleasedServiceFixture(directory)
      const externalNodePath = process.execPath

      const definition = await resolveManagedPm2ServiceDefinition(
        loadedManifest,
        paths,
        "server",
        undefined,
        undefined,
        undefined,
        { externalNodePath }
      )

      expect(definition.nodePath).toBe(externalNodePath)
      expect(definition.useManagedNodeRuntime).toBe(false)
      expect(definition.dotnetPath).toContain(
        path.join("components", "dotnet", "runtime", "current")
      )
      expect(definition.releasedServiceStartScriptPath).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("fails fast when a node-less released service has no external Node executable available", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-pm2-node-less-"))

    try {
      const { loadedManifest, paths } = await setUpNodeLessReleasedServiceFixture(directory)

      await expect(
        resolveManagedPm2ServiceDefinition(loadedManifest, paths, "server")
      ).rejects.toThrow(/external Node executable/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
