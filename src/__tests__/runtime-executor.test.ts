import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { buildManagedRuntimeEnvironment } from "../runtime/runtime-executor.js"
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
    expect(env.PATH?.startsWith(
        [
          path.join(runtimeRoot, "program", "components", "node", "bin"),
          path.join(runtimeRoot, "program", "npm", "bin"),
          path.join(runtimeRoot, "program", "bin")
        ].join(process.platform === "win32" ? ";" : ":")
      )).toBe(true)
    expect(env.CUSTOM_FLAG).toBe("1")
  })
})
