import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import process from "node:process"
import { stringify } from "yaml"
import { describe, expect, it } from "vitest"
import {
  resolveManagedPm2Environment,
  resolveManagedPm2ServiceDefinition,
  runManagedPm2Command
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

async function createManagedPm2Fixture(options: {
  nodeRequired?: boolean
  missingNode?: boolean
  missingPm2Dependency?: boolean
  dependencyWithoutMain?: boolean
  missingHostNode?: boolean
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-managed-pm2-"))
  const runtimeDirectory = path.join(directory, "runtime")
  const runtimeRoot = path.join(directory, "runtime-root")
  const manifestPath = path.join(runtimeDirectory, "manifest.yaml")
  const bundledPrefix = path.join(directory, "desktop-pm2-prefix")
  const hostNodePath = path.join(directory, "external-node.exe")
  const serverInstallPath = path.join(runtimeRoot, "server", "versions", "1.0.0")

  await cp(packagedRuntimeDirectory, runtimeDirectory, { recursive: true })
  const manifest = (await readFile(manifestPath, "utf8")).replace(/\r\n/g, "\n")
  const manifestObject = (await import("yaml")).parse(manifest) as {
    paths: {
      npmPrefix: string
      nodeRuntime: string
      runtimeDataRoot: string
      serverDataRoot?: string
      serverProgramRoot?: string
    }
    components: Array<{
      name: string
      required?: boolean
      source?: string
      releasedService?: { startScript?: string }
    }>
  }
  manifestObject.paths.nodeRuntime = path.join(runtimeRoot, "program", "components", "node", "runtime")
  manifestObject.paths.npmPrefix = bundledPrefix
  manifestObject.paths.runtimeDataRoot = path.join(directory, "runtime-data")
  manifestObject.paths.serverDataRoot = path.join(directory, "server-data")
  manifestObject.paths.serverProgramRoot = path.join(runtimeRoot, "server")
  const nodeComponent = manifestObject.components.find((component) => component.name === "node")
  if (nodeComponent) {
    nodeComponent.required = options.nodeRequired ?? true
    if (options.nodeRequired !== false) {
      nodeComponent.source = "desktop-bundled-pm2-node"
    }
  }
  const serverComponent = manifestObject.components.find((component) => component.name === "server")
  if (serverComponent?.releasedService) {
    delete serverComponent.releasedService.startScript
  }
  await writeFile(manifestPath, stringify(manifestObject))

  const loadedManifest = await loadRuntimeManifest({ manifestPath })
  const paths = resolveRuntimePaths(loadedManifest, { runtimeRoot })
  const nodeRoot = paths.nodeRuntime
  const nodePath = process.platform === "win32"
    ? path.join(nodeRoot, "node.exe")
    : path.join(nodeRoot, "bin", "node")
  const pm2Root = process.platform === "win32"
    ? path.join(paths.npmPrefix, "node_modules", "pm2")
    : path.join(paths.npmPrefix, "lib", "node_modules", "pm2")
  const pm2Entrypoint = path.join(pm2Root, "bin", "pm2")
  const pm2DependencyRoot = path.join(paths.npmPrefix, "lib", "node_modules", "pm2-fixture-dependency")
  const dotnetPath = path.join(paths.dotnetRuntime, "current", process.platform === "win32" ? "dotnet.exe" : "dotnet")

  await Promise.all([
    mkdir(path.dirname(nodePath), { recursive: true }),
    mkdir(path.dirname(pm2Entrypoint), { recursive: true }),
    mkdir(path.join(serverInstallPath, "lib"), { recursive: true }),
    mkdir(path.dirname(dotnetPath), { recursive: true }),
    mkdir(path.dirname(getManagedServerVersionStatePath(paths)), { recursive: true }),
    ...(options.missingPm2Dependency ? [] : [mkdir(pm2DependencyRoot, { recursive: true })]),
  ])
  if (!options.missingNode) {
    await writeFile(nodePath, "")
  }
  await Promise.all([
    writeFile(pm2Entrypoint, ""),
    writeFile(
      path.join(pm2Root, "package.json"),
      JSON.stringify({
        name: "pm2",
        version: "7.0.1",
        dependencies: options.missingPm2Dependency ? { "pm2-fixture-dependency": "1.0.0" } : {},
      })
    ),
    ...(!options.missingPm2Dependency
      ? [
          ...(!options.dependencyWithoutMain
            ? [writeFile(path.join(pm2DependencyRoot, "index.js"), "")]
            : []),
          writeFile(
            path.join(pm2DependencyRoot, "package.json"),
            JSON.stringify({ name: "pm2-fixture-dependency", version: "1.0.0" })
          ),
        ]
      : []),
    writeFile(path.join(serverInstallPath, "lib", "PCode.Web.dll"), ""),
    writeFile(dotnetPath, ""),
    ...(!options.missingHostNode ? [writeFile(hostNodePath, "")] : []),
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
              assetName: "server",
            },
          },
        },
      })
    ),
  ])

  return {
    directory,
    hostNodePath,
    loadedManifest,
    manifestPath,
    nodePath,
    paths,
    pm2Entrypoint,
  }
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

  it("uses Desktop's required bundled Node and PM2 prefix under external dependency policy", async () => {
    const fixture = await createManagedPm2Fixture()
    try {
      const definition = await resolveManagedPm2ServiceDefinition(
        fixture.loadedManifest,
        fixture.paths,
        "server",
        undefined,
        undefined,
        undefined,
        {
          consumer: "windows-store",
          dependencyManagementMode: "external-managed",
          externalNodePath: fixture.hostNodePath,
        }
      )

      expect(definition.nodePath).toBe(fixture.nodePath)
      expect(definition.useManagedNodeRuntime).toBe(true)
      expect(definition.pm2Binary).toBe(fixture.pm2Entrypoint)
      expect(definition.pm2Binary).not.toContain("external")
      expect(definition.dotnetPath).toBe(
        path.join(fixture.paths.dotnetRuntime, "current", process.platform === "win32" ? "dotnet.exe" : "dotnet")
      )
      expect(definition.launchStrategy).toBe("released-service")
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it("reports a missing bundled Node executable instead of selecting external Node", async () => {
    const fixture = await createManagedPm2Fixture({ missingNode: true })
    try {
      await expect(
        resolveManagedPm2ServiceDefinition(
          fixture.loadedManifest,
          fixture.paths,
          "server",
          undefined,
          undefined,
          undefined,
          {
            consumer: "windows-store",
            dependencyManagementMode: "external-managed",
            externalNodePath: fixture.hostNodePath,
          }
        )
      ).rejects.toThrow(/Managed Node executable for PM2 is missing/)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it("starts with the bundled interpreter when host Node is absent", async () => {
    const fixture = await createManagedPm2Fixture({ missingHostNode: true })
    try {
      const definition = await resolveManagedPm2ServiceDefinition(
        fixture.loadedManifest,
        fixture.paths,
        "server",
        undefined,
        undefined,
        undefined,
        {
          consumer: "windows-store",
          dependencyManagementMode: "external-managed",
        }
      )

      expect(definition.nodePath).toBe(fixture.nodePath)
      expect(definition.useManagedNodeRuntime).toBe(true)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it("reports missing PM2 production dependencies", async () => {
    const fixture = await createManagedPm2Fixture({ missingPm2Dependency: true })
    try {
      await expect(
        resolveManagedPm2ServiceDefinition(fixture.loadedManifest, fixture.paths, "server")
      ).rejects.toThrow(/PM2 runtime dependency "pm2-fixture-dependency".*is missing/)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it("accepts PM2 dependencies without a package entry point", async () => {
    const fixture = await createManagedPm2Fixture({ dependencyWithoutMain: true })
    try {
      const definition = await resolveManagedPm2ServiceDefinition(
        fixture.loadedManifest,
        fixture.paths,
        "server"
      )
      expect(definition.pm2Binary).toBe(fixture.pm2Entrypoint)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it("uses the bundled interpreter for PM2 start, status, and stop actions", async () => {
    const fixture = await createManagedPm2Fixture({ missingHostNode: true })
    const invocations: Array<{ command: string; args: string[] }> = []
    const runner = async (command: string, args: string[], options: { cwd: string }) => {
      invocations.push({ command, args })
      return {
        command,
        args,
        stdout: "[]",
        stderr: "",
        cwd: options.cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
      }
    }

    try {
      for (const action of ["start", "status", "stop"] as const) {
        await runManagedPm2Command({
          manifestPath: fixture.manifestPath,
          runtimeRoot: fixture.paths.root,
          service: "server",
          action,
          consumer: "windows-store",
          dependencyManagementMode: "external-managed",
          externalNodePath: fixture.hostNodePath,
          runner,
        })
      }

      expect(invocations.length).toBeGreaterThan(0)
      expect(invocations.every((invocation) => invocation.command === fixture.nodePath)).toBe(true)
      expect(invocations.every((invocation) => invocation.args[0] === fixture.pm2Entrypoint)).toBe(true)
      const definition = await resolveManagedPm2ServiceDefinition(
        fixture.loadedManifest,
        fixture.paths,
        "server"
      )
      expect(definition.ecosystemPath).toBeDefined()
      const ecosystem = await readFile(definition.ecosystemPath!, "utf8")
      expect(ecosystem).toContain(`script: ${JSON.stringify(definition.dotnetPath)}`)
      expect(ecosystem).toContain('interpreter: "none"')
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it("sets the bundled Node path in the PM2 daemon environment", async () => {
    const fixture = await createManagedPm2Fixture()
    try {
      const environment = await resolveManagedPm2Environment({
        manifestPath: fixture.manifestPath,
        runtimeRoot: fixture.paths.root,
        service: "server",
        consumer: "windows-store",
        dependencyManagementMode: "external-managed",
        externalNodePath: fixture.hostNodePath,
      })

      expect(environment.nodePath).toBe(fixture.nodePath)
      expect(environment.useManagedNodeRuntime).toBe(true)
      expect(environment.env.NODE).toBe(fixture.nodePath)
      expect(environment.env.npm_node_execpath).toBe(fixture.nodePath)
      expect(environment.pathEntries).toContain(path.dirname(fixture.nodePath))
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it("preserves external Node policy for non-Desktop runtimes", async () => {
    const fixture = await createManagedPm2Fixture({ nodeRequired: false })
    try {
      const definition = await resolveManagedPm2ServiceDefinition(
        fixture.loadedManifest,
        fixture.paths,
        "server",
        undefined,
        undefined,
        undefined,
        {
          dependencyManagementMode: "external-managed",
          externalNodePath: fixture.hostNodePath,
        }
      )

      expect(definition.nodePath).toBe(fixture.hostNodePath)
      expect(definition.useManagedNodeRuntime).toBe(false)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
