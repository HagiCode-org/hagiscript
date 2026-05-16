import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  getManagedServerConfig,
  setManagedServerConfig
} from "../runtime/server-config.js"

describe("managed server config", () => {
  it("reads default values from manifest when no config file exists", async () => {
    const fixture = await createRuntimeFixture()

    try {
      const result = await getManagedServerConfig({
        manifestPath: fixture.manifestPath,
        runtimeRoot: fixture.runtimeRoot
      })

      expect(result.host).toBe("127.0.0.1")
      expect(result.port).toBe(39150)
      expect(result.aspNetCoreUrls).toBe("http://127.0.0.1:39150")
      expect(result.configPath).toBe(
        path.join(fixture.runtimeRoot, "runtime-data", "server", "config", "server-config.json")
      )
      expect(result.source).toBe("manifest-default")
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it("persists host and port updates to config file", async () => {
    const fixture = await createRuntimeFixture()

    try {
      const saved = await setManagedServerConfig(
        {
          host: "0.0.0.0",
          port: 39160
        },
        {
          manifestPath: fixture.manifestPath,
          runtimeRoot: fixture.runtimeRoot
        }
      )

      expect(saved.aspNetCoreUrls).toBe("http://0.0.0.0:39160")
      expect(saved.configPath).toBe(
        path.join(fixture.runtimeRoot, "runtime-data", "server", "config", "server-config.json")
      )
      expect(saved.source).toBe("config-file")

      const raw = await readFile(saved.configPath, "utf8")
      expect(raw).toContain('"host": "0.0.0.0"')
      expect(raw).toContain('"port": 39160')

      const loaded = await getManagedServerConfig({
        manifestPath: fixture.manifestPath,
        runtimeRoot: fixture.runtimeRoot
      })
      expect(loaded.host).toBe("0.0.0.0")
      expect(loaded.port).toBe(39160)
      expect(loaded.source).toBe("config-file")
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

async function createRuntimeFixture(): Promise<{
  root: string
  runtimeRoot: string
  manifestPath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), "hagiscript-server-config-"))
  const runtimeRoot = path.join(root, "runtime-root")
  const manifestPath = path.join(root, "manifest.yaml")
  const scriptsDir = path.join(root, "scripts")

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
      env:
        ASPNETCORE_URLS: "http://127.0.0.1:39150"
    releasedService:
      dllPath: "lib/PCode.Web.dll"
      workingDirectory: "lib"
`,
    "utf8"
  )

  return {
    root,
    runtimeRoot,
    manifestPath
  }
}