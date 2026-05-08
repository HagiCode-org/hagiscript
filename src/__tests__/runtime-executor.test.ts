import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  buildManagedRuntimeEnvironment,
  getManagedNpmBinDirectory,
  prependPathEntries
} from "../runtime/runtime-executor.js"
import { getRuntimeExecutablePaths } from "../runtime/node-verify.js"
import { loadRuntimeManifest } from "../runtime/runtime-manifest.js"
import {
  getComponentConfigDirectory,
  getComponentManagedRoot,
  getComponentPm2Home,
  getComponentRuntimeDataHome,
  resolveRuntimePaths
} from "../runtime/runtime-paths.js"

const fixtureManifestPath = path.resolve(
  fileURLToPath(
    new URL("../../tests/runtime/fixtures/runtime-manifest.yaml", import.meta.url)
  )
)

describe("runtime executor environment", () => {
  it("injects canonical runtime homes, PM2 home, and managed PATH entries", async () => {
    const runtimeRoot = path.resolve("tmp", "hagiscript-runtime")
    const manifest = await loadRuntimeManifest({ manifestPath: fixtureManifestPath })
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    const component = manifest.componentMap.get("alpha")

    expect(component).toBeDefined()

    const env = buildManagedRuntimeEnvironment(
      {
        component: component!,
        manifest,
        paths,
        componentRoot: getComponentManagedRoot(paths, "alpha"),
        componentConfigDir: getComponentConfigDirectory(
          paths,
          "alpha",
          component?.runtimeDataDir
        ),
        componentDataHome: getComponentRuntimeDataHome(
          paths,
          "alpha",
          component?.runtimeDataDir
        ),
        pm2Home: getComponentPm2Home(paths, "alpha", component?.runtimeDataDir),
        phase: "install",
        scriptBasename: "install-component.mjs"
      },
      {
        PATH: "/usr/bin",
        CUSTOM_FLAG: "1"
      }
    )

    expect(env.HAGICODE_RUNTIME_HOME).toBe(path.join(runtimeRoot, "program"))
    expect(env.HAGICODE_RUNTIME_DATA_HOME).toBe(
      path.join(runtimeRoot, "runtime-data", "components", "alpha-data")
    )
    expect(env.PM2_HOME).toBe(
      path.join(
        runtimeRoot,
        "runtime-data",
        "components",
        "alpha-data",
        "pm2"
      )
    )
    const expectedPathPrefix = [
      path.dirname(getRuntimeExecutablePaths(paths.nodeRuntime).nodePath),
      getManagedNpmBinDirectory(paths.npmPrefix),
      paths.bin
    ].join(process.platform === "win32" ? ";" : ":")
    const runtimePath = env.Path ?? env.PATH
    expect(runtimePath?.startsWith(
        expectedPathPrefix
      )).toBe(true)
    expect(env.CUSTOM_FLAG).toBe("1")
  })

  it("normalizes duplicate Windows PATH keys before prepending managed entries", () => {
    const env = prependPathEntries(
      {
        PATH: "C:\\Windows\\System32",
        Path: "C:\\stale-path",
        CUSTOM_FLAG: "1"
      },
      ["C:\\managed\\node", "C:\\managed\\npm"],
      "win32"
    )

    expect(env.Path).toBe("C:\\managed\\node;C:\\managed\\npm;C:\\Windows\\System32")
    expect(env.PATH).toBeUndefined()
    expect(env.CUSTOM_FLAG).toBe("1")
  })

  it("publishes resolved absolute released-service paths into the runtime script environment", async () => {
    const runtimeRoot = path.resolve("tmp", "hagiscript-runtime-released-service")
    const manifest = await loadRuntimeManifest({ manifestPath: fixtureManifestPath })
    const paths = resolveRuntimePaths(manifest, { runtimeRoot })
    const componentRoot = path.join(runtimeRoot, "program", "components", "server")
    const env = buildManagedRuntimeEnvironment(
      {
        component: {
          name: "server",
          type: "released-service",
          releasedService: {
            dllPath: "/opt/hagicode/local-publishment/lib/PCode.Web.dll",
            workingDirectory: "/opt/hagicode/local-publishment/lib",
            configRoot: "/opt/hagicode/local-publishment/lib",
            startScript: "/opt/hagicode/local-publishment/start.sh"
          }
        },
        manifest,
        paths,
        componentRoot,
        componentConfigDir: path.join(runtimeRoot, "runtime-data", "components", "services", "server", "config")
      },
      {
        PATH: "/usr/bin"
      }
    )

    expect(env.HAGISCRIPT_RUNTIME_RELEASED_SERVICE_DLL_PATH).toBe(
      "/opt/hagicode/local-publishment/lib/PCode.Web.dll"
    )
    expect(env.HAGISCRIPT_RUNTIME_RELEASED_SERVICE_DLL_ABSOLUTE_PATH).toBe(
      "/opt/hagicode/local-publishment/lib/PCode.Web.dll"
    )
    expect(env.HAGISCRIPT_RUNTIME_RELEASED_SERVICE_WORKING_DIRECTORY_ABSOLUTE_PATH).toBe(
      "/opt/hagicode/local-publishment/lib"
    )
    expect(env.HAGISCRIPT_RUNTIME_RELEASED_SERVICE_CONFIG_ROOT_ABSOLUTE_PATH).toBe(
      "/opt/hagicode/local-publishment/lib"
    )
    expect(env.HAGISCRIPT_RUNTIME_RELEASED_SERVICE_START_SCRIPT_ABSOLUTE_PATH).toBe(
      "/opt/hagicode/local-publishment/start.sh"
    )
  })
})
