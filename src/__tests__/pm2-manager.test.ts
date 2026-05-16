import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import {
  getManagedNpmBinDirectory,
  getManagedNpmModulesDirectory,
  getManagedNpmPackagesPrefix
} from "../runtime/runtime-executor.js"
import { getRuntimeExecutablePaths } from "../runtime/node-verify.js"
import {
  resolveManagedPm2Environment,
  resolveManagedPm2ServiceDefinition,
  runManagedPm2Command
} from "../runtime/pm2-manager.js"
import { loadRuntimeManifest } from "../runtime/runtime-manifest.js"
import { resolveRuntimePaths } from "../runtime/runtime-paths.js"

const fixtureScriptPath = path.resolve(
  fileURLToPath(
    new URL("../../tests/runtime/fixtures/scripts/install-component.mjs", import.meta.url)
  )
)

describe("pm2 manager", () => {
  it("resolves service definitions from manifest overrides", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture()

    try {
      const manifest = await loadRuntimeManifest({ manifestPath: setup.manifestPath })
      const paths = resolveRuntimePaths(manifest, { runtimeRoot: setup.runtimeRoot })
      const definition = await resolveManagedPm2ServiceDefinition(
        manifest,
        paths,
        "omniroute"
      )

      expect(definition.baseAppName).toBe("fixture-omniroute")
      expect(definition.appName).toBe("fixture-omniroute-fixture")
      expect(definition.nameIdentifierEnv).toBe("hagicode_instance")
      expect(definition.nameIdentifier).toBe("fixture")
      expect(definition.cwd).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "services",
          "omniroute",
          "current"
        )
      )
      expect(definition.script).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "services",
          "omniroute",
          "current",
          "custom-launcher.mjs"
        )
      )
      expect(definition.pm2Home).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "omniroute",
          ".pm2"
        )
      )
      expect(definition.env.RUNTIME_MODE).toBe("fixture")
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("starts managed services with the runtime-scoped PM2 binary and env", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture()
    let jlistCallCount = 0
    const runner = vi.fn(async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (args[1] === "jlist") {
        jlistCallCount += 1
        return {
          command,
          args,
          stdout:
            jlistCallCount === 1
              ? "[]"
              : JSON.stringify([
                  {
                    name: "fixture-omniroute-fixture",
                    pid: 4242,
                    pm2_env: { status: "online" }
                  }
                ]),
          stderr: ""
        }
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: "",
        cwd: options?.env?.PWD
      }
    })

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "start",
        runner
      })

      expect(runner).toHaveBeenCalledTimes(3)
      expect(runner.mock.calls[1]?.[0]).toBe(getFixtureNodePath(setup.runtimeRoot))
      expect(runner.mock.calls[1]?.[1]).toEqual([
        process.platform === "win32"
          ? path.join(
              setup.runtimeRoot,
              "runtime-data",
              "npm",
              "node_modules",
              "pm2",
              "bin",
              "pm2"
            )
          : path.join(
              setup.runtimeRoot,
              "runtime-data",
              "npm",
              "lib",
              "node_modules",
              "pm2",
              "bin",
              "pm2"
            ),
        "start",
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "services",
          "omniroute",
          "current",
          "custom-launcher.mjs"
        ),
        "--name",
        "fixture-omniroute-fixture",
        "--cwd",
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "services",
          "omniroute",
          "current"
        ),
        "--interpreter",
        getFixtureNodePath(setup.runtimeRoot),
        "--update-env",
        "--",
        "--port",
        "39001"
      ])
      expect(runner.mock.calls[1]?.[2]?.env?.HAGICODE_RUNTIME_HOME).toBe(
        path.join(setup.runtimeRoot, "program")
      )
      expect(runner.mock.calls[1]?.[2]?.env?.HAGICODE_RUNTIME_DATA_HOME).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "omniroute"
        )
      )
      expect(runner.mock.calls[1]?.[2]?.env?.PM2_HOME).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "omniroute",
          ".pm2"
        )
      )
      const runtimePath =
        runner.mock.calls[1]?.[2]?.env?.Path ?? runner.mock.calls[1]?.[2]?.env?.PATH
      const manifest = await loadRuntimeManifest({ manifestPath: setup.manifestPath })
      const paths = resolveRuntimePaths(manifest, { runtimeRoot: setup.runtimeRoot })
      expect(runtimePath).toContain(path.dirname(getFixtureNodePath(setup.runtimeRoot)))
      expect(runtimePath).toContain(getManagedNpmBinDirectory(getManagedNpmPackagesPrefix(paths)))
      expect(runtimePath).toContain(path.join(setup.runtimeRoot, "program", "bin"))
      expect(runner.mock.calls[1]?.[2]?.env?.hagicode_instance).toBe("fixture")
      expect(result.status).toBe("online")
      expect(result.pid).toBe(4242)
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("treats start as a no-op when the managed service is already online", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture()
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args[1] === "jlist") {
        return {
          command,
          args,
          stdout: JSON.stringify([
            {
              name: "fixture-omniroute-fixture",
              pid: 4242,
              pm2_env: { status: "online" }
            }
          ]),
          stderr: ""
        }
      }

      throw new Error(`Unexpected PM2 mutation command: ${args.join(" ")}`)
    })

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "start",
        runner
      })

      expect(result.status).toBe("online")
      expect(result.pid).toBe(4242)
      expect(runner).toHaveBeenCalledTimes(1)
      expect(runner.mock.calls[0]?.[1]).toEqual([
        getFixturePm2Entrypoint(setup.runtimeRoot),
        "jlist"
      ])
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("resolves released-service server definitions from the manifest", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture()

    try {
      const manifest = await loadRuntimeManifest({ manifestPath: setup.manifestPath })
      const paths = resolveRuntimePaths(manifest, { runtimeRoot: setup.runtimeRoot })
      const definition = await resolveManagedPm2ServiceDefinition(manifest, paths, "server")

      expect(definition.launchStrategy).toBe("released-service")
      expect(definition.baseAppName).toBe("fixture-server")
      expect(definition.appName).toBe("fixture-server-fixture")
      expect(definition.nameIdentifierEnv).toBe("hagicode_instance")
      expect(definition.nameIdentifier).toBe("fixture")
      expect(definition.script).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "server",
          "versions",
          "1.2.3",
          "lib",
          "PCode.Web.dll"
        )
      )
      expect(definition.cwd).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "server",
          "versions",
          "1.2.3",
          "lib"
        )
      )
      expect(definition.runtimeFilesDir).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "server",
          "pm2-runtime"
        )
      )
      expect(definition.dotnetPath).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "dotnet",
          "current",
          process.platform === "win32" ? "dotnet.exe" : "dotnet"
        )
      )
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })
  it("uses the service app name for the default shared PM2 home when no override is set", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture({ includePm2HomeOverride: false })

    try {
      const manifest = await loadRuntimeManifest({ manifestPath: setup.manifestPath })
      const paths = resolveRuntimePaths(manifest, { runtimeRoot: setup.runtimeRoot })
      const definition = await resolveManagedPm2ServiceDefinition(manifest, paths, "omniroute")

      expect(definition.baseAppName).toBe("fixture-omniroute")
      expect(definition.pm2Home).toBe(
        path.join(homedir(), ".hagiscript", "pm2", "fixture-omniroute")
      )
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("reports reusable launch environment for released-service server startup", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture()

    try {
      const report = await resolveManagedPm2Environment({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server"
      })
      const manifest = await loadRuntimeManifest({ manifestPath: setup.manifestPath })
      const paths = resolveRuntimePaths(manifest, { runtimeRoot: setup.runtimeRoot })

      expect(report.launchStrategy).toBe("released-service")
      expect(report.baseAppName).toBe("fixture-server")
      expect(report.appName).toBe("fixture-server-fixture")
      expect(report.nameIdentifierEnv).toBe("hagicode_instance")
      expect(report.nameIdentifier).toBe("fixture")
      expect(report.bootstrapNameIdentifierValue).toBe("hagicode")
      expect(report.dotnetPath).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "dotnet",
          "current",
          process.platform === "win32" ? "dotnet.exe" : "dotnet"
        )
      )
      expect(report.pathEntries[0]).toBe(path.dirname(getFixtureNodePath(setup.runtimeRoot)))
      expect(report.pathEntries).toEqual(
        expect.arrayContaining([
          getManagedNpmBinDirectory(getManagedNpmPackagesPrefix(paths)),
          path.join(setup.runtimeRoot, "program", "bin")
        ])
      )
      expect(report.env.HAGISCRIPT_RUNTIME_COMPONENT_NAME).toBe("server")
      expect(report.env.hagicode_instance).toBe("fixture")
      expect(report.env.ASPNETCORE_URLS).toBe("http://127.0.0.1:39150")
      expect(report.env.ASPNETCORE_ENVIRONMENT).toBe("Production")
      expect(report.env.HAGICODE_AGENT_CLI_PATH).toBe(
        getManagedNpmBinDirectory(getManagedNpmPackagesPrefix(paths))
      )
      expect(report.env.HAGICODE_NPM_GLOBAL_PATH).toBe(
        getManagedNpmPackagesPrefix(paths)
      )
      expect(report.env.HAGICODE_NPM_GLOBAL_MODULES_ROOT).toBe(
        getManagedNpmModulesDirectory(getManagedNpmPackagesPrefix(paths))
      )
      expect(
        report.env.NODE_PATH?.startsWith(
          [
            getManagedNpmModulesDirectory(getManagedNpmPackagesPrefix(paths))
          ].join(path.delimiter)
        )
      ).toBe(true)
      expect(report.env.HAGISCRIPT_RUNTIME_NPM_PACKAGES_PREFIX).toBe(
        getManagedNpmPackagesPrefix(paths)
      )
      expect(report.env[report.pathKey]?.startsWith(report.pathEntries.join(path.delimiter))).toBe(
        true
      )
      expect(report.ecosystemPath).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "server",
          "pm2-runtime",
          "ecosystem.config.cjs"
        )
      )
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("accepts an explicit PM2 name identifier without relying on process.env", async () => {
    const setup = await createPm2Fixture()

    try {
      const report = await resolveManagedPm2Environment({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        nameIdentifierValue: "custom01"
      })

      expect(report.nameIdentifier).toBe("custom01")
      expect(report.appName).toBe("fixture-server-custom01")
      expect(report.env.hagicode_instance).toBe("custom01")
    } finally {
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("preserves an inherited ASPNETCORE_ENVIRONMENT for server startup", async () => {
    const restoreNameEnv = setPm2NameIdentifierEnv("fixture")
    const previousAspNetCoreEnvironment = process.env.ASPNETCORE_ENVIRONMENT
    process.env.ASPNETCORE_ENVIRONMENT = "Development"
    const setup = await createPm2Fixture()

    try {
      const report = await resolveManagedPm2Environment({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server"
      })

      expect(report.env.ASPNETCORE_ENVIRONMENT).toBe("Development")
    } finally {
      restoreNameEnv()
      if (previousAspNetCoreEnvironment === undefined) {
        delete process.env.ASPNETCORE_ENVIRONMENT
      } else {
        process.env.ASPNETCORE_ENVIRONMENT = previousAspNetCoreEnvironment
      }
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("resolves released-service server definitions from external absolute paths", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const externalRoot = path.join(tmpdir(), "hagiscript-external-local-publishment")
    const setup = await createPm2Fixture({
      releasedService: {
        dllPath: path.join(externalRoot, "lib", "PCode.Web.dll"),
        workingDirectory: path.join(externalRoot, "lib")
      }
    })

    try {
      const manifest = await loadRuntimeManifest({ manifestPath: setup.manifestPath })
      const paths = resolveRuntimePaths(manifest, { runtimeRoot: setup.runtimeRoot })
      const definition = await resolveManagedPm2ServiceDefinition(manifest, paths, "server")

      expect(definition.script).toBe(path.join(externalRoot, "lib", "PCode.Web.dll"))
      expect(definition.cwd).toBe(path.join(externalRoot, "lib"))
      expect(definition.launchStrategy).toBe("released-service")
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("retries retryable bootstrap PM2 output before returning status", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture()
    let jlistCallCount = 0
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args[1] === "jlist") {
        jlistCallCount += 1
        if (jlistCallCount === 1) {
          return {
            command,
            args,
            stdout: "",
            stderr: "[PM2] PM2 Successfully daemonized\n[PM2] pm2 home=/tmp/.pm2\n"
          }
        }

        if (jlistCallCount === 2) {
          return {
            command,
            args,
            stdout: "[]",
            stderr: ""
          }
        }

        return {
          command,
          args,
          stdout: JSON.stringify([
              {
                name: "fixture-server-fixture",
                pid: 9898,
                pm2_env: { status: "online" }
            }
          ]),
          stderr: ""
        }
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: ""
      }
    })

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        action: "start",
        runner
      })

      expect(result.status).toBe("online")
      expect(result.runtimeFilesDir).toBeTruthy()
      expect(jlistCallCount).toBe(3)
      expect(runner.mock.calls[2]?.[1]).toEqual([
        process.platform === "win32"
          ? path.join(
              setup.runtimeRoot,
              "runtime-data",
              "npm",
              "node_modules",
              "pm2",
              "bin",
              "pm2"
            )
          : path.join(
              setup.runtimeRoot,
              "runtime-data",
              "npm",
              "lib",
              "node_modules",
              "pm2",
              "bin",
              "pm2"
            ),
        "start",
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "server",
          "pm2-runtime",
          "ecosystem.config.cjs"
        ),
        "--only",
        "fixture-server-fixture",
        "--update-env"
      ])
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("writes released-service environment into the generated ecosystem config", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture")
    const setup = await createPm2Fixture()
    let jlistCallCount = 0
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (args[1] === "jlist") {
        jlistCallCount += 1
        return {
          command,
          args,
          stdout:
            jlistCallCount === 1
              ? "[]"
              : JSON.stringify([
                  {
                    name: "fixture-server-fixture",
                    pid: 9898,
                    pm2_env: { status: "online" }
                  }
                ]),
          stderr: ""
        }
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: ""
      }
    })

    try {
      await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        action: "start",
        runner
      })

      const ecosystemConfig = await readFile(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "server",
          "pm2-runtime",
          "ecosystem.config.cjs"
        ),
        "utf8"
      )

      expect(ecosystemConfig).toContain("env:")
      expect(ecosystemConfig).toContain('"ASPNETCORE_URLS": "http://127.0.0.1:39150"')
      expect(ecosystemConfig).toContain('"hagicode_instance": "fixture"')
      expect(ecosystemConfig).toContain("env_file")
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("fails PM2 actions early when the required naming identifier is missing", async () => {
    const setup = await createPm2Fixture()
    const runner = vi.fn()

    try {
      for (const action of ["start", "restart", "stop", "delete", "status"] as const) {
        await expect(
          runManagedPm2Command({
            manifestPath: setup.manifestPath,
            runtimeRoot: setup.runtimeRoot,
            service: "server",
            action,
            runner
          })
        ).rejects.toThrow(
          /requires a runtime instance name.*runtime\.hagicodeInstance.*hagicode_instance/
        )
      }

      await expect(
        resolveManagedPm2Environment({
          manifestPath: setup.manifestPath,
          runtimeRoot: setup.runtimeRoot,
          service: "server"
        })
      ).rejects.toThrow(
        /requires a runtime instance name.*runtime\.hagicodeInstance.*hagicode_instance/
      )
      expect(runner).not.toHaveBeenCalled()
    } finally {
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  it("fails PM2 actions early when the resolved naming identifier is invalid", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("Fixture-01")
    const setup = await createPm2Fixture()
    const runner = vi.fn()

    try {
      await expect(
        runManagedPm2Command({
          manifestPath: setup.manifestPath,
          runtimeRoot: setup.runtimeRoot,
          service: "omniroute",
          action: "status",
          runner
        })
      ).rejects.toThrow(
        /requires hagicode_instance to use only lowercase letters, digits, and underscores/
      )
      await expect(
        resolveManagedPm2Environment({
          manifestPath: setup.manifestPath,
          runtimeRoot: setup.runtimeRoot,
          service: "omniroute"
        })
      ).rejects.toThrow(
        /requires hagicode_instance to use only lowercase letters, digits, and underscores/
      )
      expect(runner).not.toHaveBeenCalled()
    } finally {
      restoreEnv()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })
})

async function createPm2Fixture(options: {
  releasedService?: {
    dllPath: string
    workingDirectory: string
  }
  includePm2HomeOverride?: boolean
} = {}): Promise<{
  directory: string
  manifestPath: string
  runtimeRoot: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-pm2-"))
  const runtimeRoot = path.join(directory, "managed-runtime")
  const manifestPath = path.join(directory, "manifest.yaml")
  const componentRoot = path.join(
    runtimeRoot,
    "program",
    "components",
    "services",
    "omniroute"
  )
  const serverVersionRoot = path.join(runtimeRoot, "program", "server", "versions", "1.2.3")

  await mkdir(path.join(componentRoot, "current"), { recursive: true })
  const releasedService = {
    dllPath: options.releasedService?.dllPath ?? "lib/PCode.Web.dll",
    workingDirectory: options.releasedService?.workingDirectory ?? "lib"
  }
  const pm2HomeOverrideLine = options.includePm2HomeOverride === false
    ? ""
    : '      pm2Home: ".pm2"\n'
  const payloadPath = path.isAbsolute(releasedService.dllPath)
    ? releasedService.dllPath
    : path.join(serverVersionRoot, releasedService.dllPath)
  const workingDirectoryPath = path.isAbsolute(releasedService.workingDirectory)
    ? releasedService.workingDirectory
    : path.join(serverVersionRoot, releasedService.workingDirectory)

  await mkdir(workingDirectoryPath, {
    recursive: true
  })
  await mkdir(path.join(runtimeRoot, "runtime-data", "server"), { recursive: true })
  await mkdir(path.join(runtimeRoot, "runtime-data", "npm", "bin"), { recursive: true })
  await mkdir(getFixturePm2EntrypointDirectory(runtimeRoot), { recursive: true })
  await mkdir(path.join(runtimeRoot, "program", "components", "node", "bin"), {
    recursive: true
  })
  await mkdir(path.join(runtimeRoot, "program", "components", "dotnet", "current"), {
    recursive: true
  })
  await writeFile(
    path.join(componentRoot, "current", "custom-launcher.mjs"),
    "process.stdout.write('fixture launcher\\n')\n",
    "utf8"
  )
  await writeFile(
    path.join(runtimeRoot, "runtime-data", "npm", "bin", "pm2"),
    "#!/usr/bin/env sh\n",
    "utf8"
  )
  if (process.platform !== "win32") {
    await chmod(path.join(runtimeRoot, "runtime-data", "npm", "bin", "pm2"), 0o755)
  }
  await writeFile(
    getFixturePm2Entrypoint(runtimeRoot),
    "console.log('pm2 entrypoint');\n",
    "utf8"
  )
  await writeFile(
    getFixtureNodePath(runtimeRoot),
    "#!/usr/bin/env sh\n",
    "utf8"
  )
  await writeFile(payloadPath, "fixture server payload\n", "utf8")
  await writeFile(
    path.join(runtimeRoot, "runtime-data", "server", "versions-state.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        activeVersion: "1.2.3",
        versions: {
          "1.2.3": {
            version: "1.2.3",
            installPath: serverVersionRoot.replaceAll("\\", "/"),
            installedAt: "2026-05-13T00:00:00.000Z",
            source: {
              kind: "local-archive",
              locator: "/tmp/hagicode-1.2.3-linux-x64-nort.zip",
              assetName: "hagicode-1.2.3-linux-x64-nort.zip"
            }
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  await writeFile(
    path.join(
      runtimeRoot,
      "program",
      "components",
      "dotnet",
      "current",
      process.platform === "win32" ? "dotnet.exe" : "dotnet"
    ),
    "#!/usr/bin/env sh\n",
    "utf8"
  )
  if (process.platform !== "win32") {
    await chmod(getFixturePm2Entrypoint(runtimeRoot), 0o755)
    await chmod(getFixtureNodePath(runtimeRoot), 0o755)
    await chmod(
      path.join(
        runtimeRoot,
        "program",
        "components",
        "dotnet",
        "current",
        "dotnet"
      ),
      0o755
    ).catch(() => undefined)
  }

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
  nodeRuntime: "components/node"
  dotnetRuntime: "components/dotnet"
  vendoredRoot: "components/services"
phases:
  install:
    order: ["node", "dotnet", "omniroute", "server"]
  remove:
    order: ["server", "omniroute", "dotnet", "node"]
  update:
    order: ["node", "dotnet", "omniroute", "server"]
components:
  - name: "node"
    type: "runtime"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
  - name: "dotnet"
    type: "runtime"
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
  - name: "omniroute"
    type: "bundled-runtime"
    runtimeDataDir: "services/omniroute"
    lifecycleDependencies: ["node"]
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "fixture-omniroute"
      nameIdentifierEnv: "hagicode_instance"
      cwd: "current"
      script: "current/custom-launcher.mjs"
${pm2HomeOverrideLine}      args:
        - "--port"
        - "39001"
      env:
        RUNTIME_MODE: "fixture"
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    lifecycleDependencies: ["node", "dotnet"]
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "fixture-server"
      nameIdentifierEnv: "hagicode_instance"
${pm2HomeOverrideLine}      env:
        ASPNETCORE_URLS: "http://127.0.0.1:39150"
    releasedService:
      dllPath: "${releasedService.dllPath.replaceAll("\\", "/")}"
      workingDirectory: "${releasedService.workingDirectory.replaceAll("\\", "/")}"
      runtimeFilesDir: "pm2-runtime"
`,
    "utf8"
  )

  return {
    directory,
    manifestPath,
    runtimeRoot
  }
}

function getFixturePm2EntrypointDirectory(runtimeRoot: string): string {
  return process.platform === "win32"
    ? path.join(runtimeRoot, "runtime-data", "npm", "node_modules", "pm2", "bin")
    : path.join(runtimeRoot, "runtime-data", "npm", "lib", "node_modules", "pm2", "bin")
}

function getFixturePm2Entrypoint(runtimeRoot: string): string {
  return path.join(getFixturePm2EntrypointDirectory(runtimeRoot), "pm2")
}

function getFixtureNodePath(runtimeRoot: string): string {
  return getRuntimeExecutablePaths(
    path.join(runtimeRoot, "program", "components", "node")
  ).nodePath
}

function setPm2NameIdentifierEnv(value: string): () => void {
  const previous = process.env.hagicode_instance
  process.env.hagicode_instance = value

  return () => {
    if (previous === undefined) {
      delete process.env.hagicode_instance
      return
    }

    process.env.hagicode_instance = previous
  }
}
