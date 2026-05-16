import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  createInitialManagedServerVersionState,
  listManagedServerVersions,
  readManagedServerVersionState,
  registerManagedServerVersion,
  removeManagedServerVersion,
  setActiveManagedServerVersion
} from "../runtime/server-version-state.js"

describe("managed server version state", () => {
  it("creates an empty state when the file is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-versions-"))
    const statePath = path.join(directory, "versions-state.json")

    try {
      await expect(readManagedServerVersionState(statePath)).resolves.toEqual(
        createInitialManagedServerVersionState()
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("registers versions, tracks the active version, and lists newest first", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-versions-"))
    const statePath = path.join(directory, "versions-state.json")

    try {
      await registerManagedServerVersion(statePath, {
        version: "1.2.3",
        installPath: "/runtime/program/server/versions/1.2.3",
        installedAt: "2026-05-13T00:00:00.000Z",
        source: {
          kind: "local-archive",
          locator: "/tmp/hagicode-1.2.3-linux-x64-nort.zip",
          assetName: "hagicode-1.2.3-linux-x64-nort.zip"
        }
      })
      await registerManagedServerVersion(
        statePath,
        {
          version: "1.2.10",
          installPath: "/runtime/program/server/versions/1.2.10",
          installedAt: "2026-05-13T00:01:00.000Z",
          source: {
            kind: "http-index",
            locator: "https://index.hagicode.com/server/index.json@1.2.10",
            assetName: "hagicode-1.2.10-linux-x64-nort.zip"
          }
        },
        { activate: false }
      )

      await setActiveManagedServerVersion(statePath, "1.2.10")

      await expect(listManagedServerVersions(statePath)).resolves.toEqual([
        expect.objectContaining({ version: "1.2.10", active: true }),
        expect.objectContaining({ version: "1.2.3", active: false })
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("refuses to remove the active version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-server-versions-"))
    const statePath = path.join(directory, "versions-state.json")

    try {
      await registerManagedServerVersion(statePath, {
        version: "1.2.3",
        installPath: "/runtime/program/server/versions/1.2.3",
        installedAt: "2026-05-13T00:00:00.000Z",
        source: {
          kind: "local-archive",
          locator: "/tmp/hagicode-1.2.3-linux-x64-nort.zip",
          assetName: "hagicode-1.2.3-linux-x64-nort.zip"
        }
      })

      await expect(removeManagedServerVersion(statePath, "1.2.3")).rejects.toThrow(
        "currently active"
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})