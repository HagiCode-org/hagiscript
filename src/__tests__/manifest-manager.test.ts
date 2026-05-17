import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import {
  initRuntimeManifest,
  readRuntimeManifestSummary,
  renderRuntimeManifestSummaryText,
  updateRuntimeManifest
} from "../runtime/manifest-manager.js"

describe("manifest manager", () => {
  it("initializes a valid manifest from the packaged default", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-manifest-init-"))
    const manifestPath = path.join(directory, "runtime.manifest.yaml")

    try {
      const result = await initRuntimeManifest({
        manifestPath,
        pathUpdates: {
          runtimeHome: "program-alt",
          runtimeDataRoot: "runtime-data-alt",
          serverProgramRoot: "server-alt",
          serverDataRoot: "server-data-alt"
        },
        npmPackageUpdates: [
          {
            packageName: "pm2",
            version: "7.0.2",
            target: "7.0.2"
          }
        ],
        serverActiveVersion: "1.2.3"
      })

      const content = await readFile(manifestPath, "utf8")
      const manifest = parse(content) as {
        components?: Array<{ name?: string; installScript?: string }>
      }
      const nodeComponent = manifest.components?.find((component) => component.name === "node")
      expect(result.manifest.manifestPath).toBe(manifestPath)
      expect(result.changedFields).toContain("paths.runtimeHome")
      expect(content).toContain('runtimeHome: program-alt')
      expect(content).toContain('serverProgramRoot: server-alt')
      expect(content).toContain('activeVersion: 1.2.3')
      expect(nodeComponent?.installScript).toBe(path.resolve("runtime/scripts/install-node.mjs"))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("updates path and npm package settings in an existing manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-manifest-set-"))
    const manifestPath = path.join(directory, "runtime.manifest.yaml")

    try {
      await initRuntimeManifest({ manifestPath })

      const result = await updateRuntimeManifest({
        manifestPath,
        pathUpdates: {
          runtimeRoot: "~/.custom/runtime",
          runtimeHome: "program-next"
        },
        npmPackageUpdates: [
          {
            packageName: "@openai/codex",
            version: "0.126.0",
            target: "0.126.0"
          }
        ]
      })

      const content = await readFile(manifestPath, "utf8")
      expect(result.changedFields).toEqual([
        "paths.runtimeRoot",
        "paths.runtimeHome",
        "npmSync.packages.@openai/codex"
      ])
      expect(content).toContain('runtimeRoot: ~/.custom/runtime')
      expect(content).toContain('runtimeHome: program-next')
      expect(content).toContain('version: 0.126.0')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("reads and renders a friendly manifest summary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-manifest-get-"))
    const manifestPath = path.join(directory, "runtime.manifest.yaml")

    try {
      await initRuntimeManifest({
        manifestPath,
        serverActiveVersion: "2.4.6",
        npmPackageUpdates: [
          {
            packageName: "pm2",
            version: "7.0.2",
            target: "7.0.2"
          }
        ]
      })

      const summary = await readRuntimeManifestSummary(manifestPath)
      const text = renderRuntimeManifestSummaryText(summary)

      expect(summary.manifestPath).toBe(manifestPath)
      expect(summary.serverActiveVersion).toBe("2.4.6")
      expect(summary.npmPackages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ packageName: "pm2", version: "7.0.2" })
        ])
      )
      expect(text).toContain("Manifest.")
      expect(text).toContain(`Path: ${manifestPath}`)
      expect(text).toContain("Server active version: 2.4.6")
      expect(text).toContain("Managed npm packages:")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
