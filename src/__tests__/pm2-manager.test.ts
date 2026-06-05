import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CommandExecutionError } from "../runtime/command-launch.js";
import {
  getManagedNpmBinDirectory,
  getManagedNpmModulesDirectory,
  getManagedNpmPackagesPrefix
} from "../runtime/runtime-executor.js";
import { getRuntimeExecutablePaths } from "../runtime/node-verify.js";
import {
  resolveManagedPm2Environment,
  resolveManagedPm2ServiceDefinition,
  runManagedPm2Command
} from "../runtime/pm2-manager.js";
import { loadRuntimeManifest } from "../runtime/runtime-manifest.js";
import { resolveRuntimePaths } from "../runtime/runtime-paths.js";

const fixtureScriptPath = path.resolve(
  fileURLToPath(
    new URL(
      "../../tests/runtime/fixtures/scripts/install-component.mjs",
      import.meta.url
    )
  )
);

function getFixturePm2Subcommand(args: string[]): string | undefined {
  return args[1] === "--hp" ? args[3] : args[1];
}

function getFixturePm2Home(
  runtimeRoot: string,
  service: "omniroute" | "server" | "code-server"
): string {
  switch (service) {
    case "omniroute":
      return path.join(
        runtimeRoot,
        "runtime-data",
        "components",
        "services",
        "omniroute",
        ".pm2"
      );
    case "code-server":
      return path.join(
        runtimeRoot,
        "runtime-data",
        "components",
        "services",
        "code-server",
        ".pm2"
      );
    case "server":
      return path.join(runtimeRoot, "runtime-data", "server", ".pm2");
  }
}

function buildFixturePm2CliArgs(
  runtimeRoot: string,
  service: "omniroute" | "server" | "code-server",
  ...args: string[]
): string[] {
  return [
    getFixturePm2Entrypoint(runtimeRoot),
    "--hp",
    getFixturePm2Home(runtimeRoot, service),
    ...args
  ];
}

describe("pm2 manager", () => {
  it("resolves service definitions from manifest overrides", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();

    try {
      const manifest = await loadRuntimeManifest({
        manifestPath: setup.manifestPath
      });
      const paths = resolveRuntimePaths(manifest, {
        runtimeRoot: setup.runtimeRoot
      });
      const definition = await resolveManagedPm2ServiceDefinition(
        manifest,
        paths,
        "omniroute"
      );

      expect(definition.baseAppName).toBe("fixture-omniroute");
      expect(definition.appName).toBe("fixture-omniroute-fixture");
      expect(definition.nameIdentifierEnv).toBe("hagicode_instance");
      expect(definition.nameIdentifier).toBe("fixture");
      expect(definition.cwd).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "services",
          "omniroute",
          "current"
        )
      );
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
      );
      expect(definition.pm2Home).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "omniroute",
          ".pm2"
        )
      );
      expect(definition.env.RUNTIME_MODE).toBe("fixture");
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("starts managed services with the runtime-scoped PM2 binary and env", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();
    let jlistCallCount = 0;
    const runner = vi.fn(
      async (
        command: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv }
      ) => {
        if (getFixturePm2Subcommand(args) === "jlist") {
          jlistCallCount += 1;
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
          };
        }

        return {
          command,
          args,
          stdout: "started",
          stderr: "",
          cwd: options?.env?.PWD
        };
      }
    );

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "start",
        runner
      });

      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[0]?.[0]).toBe(
        getFixtureNodePath(setup.runtimeRoot)
      );
      expect(runner.mock.calls[0]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
          "stop",
          "fixture-omniroute-fixture"
        )
      ]);
      expect(runner.mock.calls[1]?.[0]).toBe(
        getFixtureNodePath(setup.runtimeRoot)
      );
      expect(runner.mock.calls[1]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
          "delete",
          "fixture-omniroute-fixture"
        )
      ]);
      expect(runner.mock.calls[2]?.[0]).toBe(
        getFixtureNodePath(setup.runtimeRoot)
      );
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
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
        )
      ]);
      expect(runner.mock.calls[2]?.[2]?.env?.HAGICODE_RUNTIME_HOME).toBe(
        path.join(setup.runtimeRoot, "program")
      );
      expect(runner.mock.calls[2]?.[2]?.env?.HAGICODE_RUNTIME_DATA_HOME).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "omniroute"
        )
      );
      expect(runner.mock.calls[2]?.[2]?.env?.PM2_HOME).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "components",
          "services",
          "omniroute",
          ".pm2"
        )
      );
      const runtimePath =
        runner.mock.calls[2]?.[2]?.env?.Path ??
        runner.mock.calls[2]?.[2]?.env?.PATH;
      const manifest = await loadRuntimeManifest({
        manifestPath: setup.manifestPath
      });
      const paths = resolveRuntimePaths(manifest, {
        runtimeRoot: setup.runtimeRoot
      });
      expect(runtimePath).toContain(
        path.dirname(getFixtureNodePath(setup.runtimeRoot))
      );
      expect(runtimePath).toContain(
        getManagedNpmBinDirectory(getManagedNpmPackagesPrefix(paths))
      );
      expect(runtimePath).toContain(
        path.join(setup.runtimeRoot, "program", "bin")
      );
      expect(runner.mock.calls[2]?.[2]?.env?.hagicode_instance).toBe("fixture");
      expect(jlistCallCount).toBe(1);
      expect(result.status).toBe("online");
      expect(result.pid).toBe(4242);
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("uses an external Node executable when the runtime node component is skipped by policy", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture({ skipManagedNodeByPolicy: true });
    const externalNodePath = getFixtureExternalNodePath(setup.directory);
    let jlistCallCount = 0;
    const runner = vi.fn(
      async (
        command: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv }
      ) => {
        if (getFixturePm2Subcommand(args) === "jlist") {
          jlistCallCount += 1;
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
          };
        }

        return {
          command,
          args,
          stdout: "started",
          stderr: "",
          cwd: options?.env?.PWD
        };
      }
    );

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "start",
        dependencyManagementMode: "external-managed",
        externalNodePath,
        runner
      });

      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[0]?.[0]).toBe(externalNodePath);
      expect(runner.mock.calls[2]?.[0]).toBe(externalNodePath);
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
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
          externalNodePath,
          "--update-env",
          "--",
          "--port",
          "39001"
        )
      ]);
      const runtimePath =
        runner.mock.calls[2]?.[2]?.env?.Path ??
        runner.mock.calls[2]?.[2]?.env?.PATH ??
        "";
      expect(runtimePath).not.toContain(
        path.dirname(getFixtureNodePath(setup.runtimeRoot))
      );
      expect(result.status).toBe("online");
      expect(jlistCallCount).toBe(1);
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("routes managed PM2 through shell launch for Windows Store/MSIX child processes", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const previousWindowsStore = process.env.HAGICODE_DESKTOP_WINDOWS_STORE;
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );

    process.env.HAGICODE_DESKTOP_WINDOWS_STORE = "1";
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32"
    });

    const setup = await createPm2Fixture();
    let jlistCallCount = 0;
    const runner = vi.fn(
      async (
        command: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv; shell?: boolean }
      ) => {
        if (getFixturePm2Subcommand(args) === "jlist") {
          jlistCallCount += 1;
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
          };
        }

        return {
          command,
          args,
          stdout: "started",
          stderr: "",
          cwd: options?.env?.PWD
        };
      }
    );

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "start",
        runner
      });

      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[0]?.[2]?.shell).toBe(true);
      expect(runner.mock.calls[1]?.[2]?.shell).toBe(true);
      expect(runner.mock.calls[2]?.[2]?.shell).toBe(true);
      expect(runner.mock.calls[3]?.[2]?.shell).toBe(true);
      expect(result.status).toBe("online");
      expect(jlistCallCount).toBe(1);
    } finally {
      restoreEnv();
      if (previousWindowsStore === undefined) {
        delete process.env.HAGICODE_DESKTOP_WINDOWS_STORE;
      } else {
        process.env.HAGICODE_DESKTOP_WINDOWS_STORE = previousWindowsStore;
      }
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("starts bundled runtimes through Node entrypoints when the manifest uses packaged defaults", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture({
      omitBundledScriptOverride: true,
      omitBundledArgsOverride: true
    });
    let jlistCallCount = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
        jlistCallCount += 1;
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
        };
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: ""
      };
    });

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "start",
        runner
      });

      expect(result.launchStrategy).toBe("node-script");
      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
          "start",
          path.join(
            setup.runtimeRoot,
            "program",
            "components",
            "services",
            "omniroute",
            "current",
            "bin",
            "omniroute.mjs"
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
          "--config",
          path.join(
            setup.runtimeRoot,
            "runtime-data",
            "components",
            "services",
            "omniroute",
            "config",
            "config.yaml"
          ),
          "--no-open"
        )
      ]);
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("starts code-server through the packaged Node entrypoint defaults", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();
    let jlistCallCount = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
        jlistCallCount += 1;
        return {
          command,
          args,
          stdout: JSON.stringify([
            {
              name: "fixture-code-server-fixture",
              pid: 5252,
              pm2_env: { status: "online" }
            }
          ]),
          stderr: ""
        };
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: ""
      };
    });

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "code-server",
        action: "start",
        runner
      });

      expect(result.launchStrategy).toBe("node-script");
      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "code-server",
          "start",
          path.join(
            setup.runtimeRoot,
            "program",
            "components",
            "services",
            "code-server",
            "current",
            "out",
            "node",
            "entry.js"
          ),
          "--name",
          "fixture-code-server-fixture",
          "--cwd",
          path.join(
            setup.runtimeRoot,
            "program",
            "components",
            "services",
            "code-server",
            "current"
          ),
          "--interpreter",
          getFixtureNodePath(setup.runtimeRoot),
          "--update-env",
          "--",
          "--config",
          path.join(
            setup.runtimeRoot,
            "runtime-data",
            "components",
            "services",
            "code-server",
            "config",
            "config.yaml"
          )
        )
      ]);
      expect(jlistCallCount).toBe(1);
      expect(result.status).toBe("online");
      expect(result.pid).toBe(5252);
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("recreates bundled services on start even when a PM2 app already exists", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
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
        };
      }

      return {
        command,
        args,
        stdout: args[1] ?? "",
        stderr: ""
      };
    });

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "start",
        runner
      });

      expect(result.status).toBe("online");
      expect(result.pid).toBe(4242);
      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[0]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
          "stop",
          "fixture-omniroute-fixture"
        )
      ]);
      expect(runner.mock.calls[1]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
          "delete",
          "fixture-omniroute-fixture"
        )
      ]);
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
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
        )
      ]);
      expect(runner.mock.calls[3]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(setup.runtimeRoot, "omniroute", "jlist")
      ]);
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("recreates released-service servers on restart before starting a fresh PM2 app", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();
    const ecosystemPath = path.join(
      setup.runtimeRoot,
      "runtime-data",
      "server",
      "pm2-runtime",
      "ecosystem.config.cjs"
    );
    const envFilePath = path.join(
      setup.runtimeRoot,
      "runtime-data",
      "server",
      "pm2-runtime",
      ".env"
    );
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
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
        };
      }

      return {
        command,
        args,
        stdout: args[1] ?? "",
        stderr: ""
      };
    });

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        action: "restart",
        runner
      });

      expect(result.status).toBe("online");
      expect(result.pid).toBe(9898);
      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[0]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "server",
          "stop",
          "fixture-server-fixture"
        )
      ]);
      expect(runner.mock.calls[1]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "server",
          "delete",
          "fixture-server-fixture"
        )
      ]);
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "server",
          "start",
          ecosystemPath,
          "--only",
          "fixture-server-fixture",
          "--update-env"
        )
      ]);
      expect(runner.mock.calls[3]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(setup.runtimeRoot, "server", "jlist")
      ]);
      expect(await readFile(ecosystemPath, "utf8")).toContain(
        '"hagicode_instance": "fixture"'
      );
      expect(await readFile(envFilePath, "utf8")).toContain(
        "ASPNETCORE_URLS=http://127.0.0.1:39150"
      );
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("resolves released-service server definitions from the manifest", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();

    try {
      const manifest = await loadRuntimeManifest({
        manifestPath: setup.manifestPath
      });
      const paths = resolveRuntimePaths(manifest, {
        runtimeRoot: setup.runtimeRoot
      });
      const definition = await resolveManagedPm2ServiceDefinition(
        manifest,
        paths,
        "server"
      );

      expect(definition.launchStrategy).toBe("released-service");
      expect(definition.baseAppName).toBe("fixture-server");
      expect(definition.appName).toBe("fixture-server-fixture");
      expect(definition.nameIdentifierEnv).toBe("hagicode_instance");
      expect(definition.nameIdentifier).toBe("fixture");
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
      );
      expect(definition.cwd).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "server",
          "versions",
          "1.2.3",
          "lib"
        )
      );
      expect(definition.runtimeFilesDir).toBe(
        path.join(setup.runtimeRoot, "runtime-data", "server", "pm2-runtime")
      );
      expect(definition.dotnetPath).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "dotnet",
          "current",
          process.platform === "win32" ? "dotnet.exe" : "dotnet"
        )
      );
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("resolves released-service startScript paths from the manifest", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture({
      releasedService: {
        dllPath: "lib/PCode.Web.dll",
        workingDirectory: "lib",
        startScript: "launcher/server-launcher.mjs"
      }
    });

    try {
      const manifest = await loadRuntimeManifest({
        manifestPath: setup.manifestPath
      });
      const paths = resolveRuntimePaths(manifest, {
        runtimeRoot: setup.runtimeRoot
      });
      const definition = await resolveManagedPm2ServiceDefinition(
        manifest,
        paths,
        "server"
      );

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
      );
      expect(definition.releasedServiceStartScriptPath).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "server",
          "versions",
          "1.2.3",
          "launcher",
          "server-launcher.mjs"
        )
      );
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("uses the service app name for the default shared PM2 home when no override is set", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture({ includePm2HomeOverride: false });

    try {
      const manifest = await loadRuntimeManifest({
        manifestPath: setup.manifestPath
      });
      const paths = resolveRuntimePaths(manifest, {
        runtimeRoot: setup.runtimeRoot
      });
      const definition = await resolveManagedPm2ServiceDefinition(
        manifest,
        paths,
        "omniroute"
      );

      expect(definition.baseAppName).toBe("fixture-omniroute");
      expect(definition.pm2Home).toBe(
        path.join(homedir(), ".hagiscript", "pm2", "fixture-omniroute")
      );
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("reports reusable launch environment for released-service server startup", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const previousAspNetCoreEnvironment = process.env.ASPNETCORE_ENVIRONMENT;
    const previousNpmConfigPrefix = process.env.NPM_CONFIG_PREFIX;
    const previousNpmConfigPrefixLower = process.env.npm_config_prefix;
    delete process.env.ASPNETCORE_ENVIRONMENT;
    process.env.NPM_CONFIG_PREFIX = "/tmp/stale-prefix";
    process.env.npm_config_prefix = "/tmp/stale-prefix";
    const setup = await createPm2Fixture();

    try {
      const report = await resolveManagedPm2Environment({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server"
      });
      const manifest = await loadRuntimeManifest({
        manifestPath: setup.manifestPath
      });
      const paths = resolveRuntimePaths(manifest, {
        runtimeRoot: setup.runtimeRoot
      });

      expect(report.launchStrategy).toBe("released-service");
      expect(report.baseAppName).toBe("fixture-server");
      expect(report.appName).toBe("fixture-server-fixture");
      expect(report.nameIdentifierEnv).toBe("hagicode_instance");
      expect(report.nameIdentifier).toBe("fixture");
      expect(report.bootstrapNameIdentifierValue).toBe("hagicode");
      expect(report.dotnetPath).toBe(
        path.join(
          setup.runtimeRoot,
          "program",
          "components",
          "dotnet",
          "current",
          process.platform === "win32" ? "dotnet.exe" : "dotnet"
        )
      );
      expect(report.pathEntries[0]).toBe(
        path.dirname(getFixtureNodePath(setup.runtimeRoot))
      );
      expect(report.pathEntries).toEqual(
        expect.arrayContaining([
          getManagedNpmBinDirectory(getManagedNpmPackagesPrefix(paths))
        ])
      );
      expect(report.pathEntries).not.toContain(
        path.join(setup.runtimeRoot, "program", "bin")
      );
      expect(report.env.HAGISCRIPT_RUNTIME_COMPONENT_NAME).toBe("server");
      expect(report.env.hagicode_instance).toBe("fixture");
      expect(report.env.ASPNETCORE_URLS).toBe("http://127.0.0.1:39150");
      expect(report.env.ASPNETCORE_ENVIRONMENT).toBe("Production");
      expect(report.env.HAGICODE_AGENT_CLI_PATH).toBe(
        getManagedNpmBinDirectory(getManagedNpmPackagesPrefix(paths))
      );
      expect(report.env.HAGICODE_NPM_GLOBAL_PATH).toBe(
        getManagedNpmPackagesPrefix(paths)
      );
      expect(report.env.HAGICODE_NPM_GLOBAL_MODULES_ROOT).toBe(
        getManagedNpmModulesDirectory(getManagedNpmPackagesPrefix(paths))
      );
      expect(
        report.env.NODE_PATH?.startsWith(
          [
            getManagedNpmModulesDirectory(getManagedNpmPackagesPrefix(paths))
          ].join(path.delimiter)
        )
      ).toBe(true);
      expect(report.env.HAGISCRIPT_RUNTIME_NPM_PACKAGES_PREFIX).toBe(
        getManagedNpmPackagesPrefix(paths)
      );
      expect(report.env.NPM_CONFIG_PREFIX).toBeUndefined();
      expect(report.env.npm_config_prefix).toBeUndefined();
      expect(
        report.env[report.pathKey]?.startsWith(
          report.pathEntries.join(path.delimiter)
        )
      ).toBe(true);
      expect(report.ecosystemPath).toBe(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "server",
          "pm2-runtime",
          "ecosystem.config.cjs"
        )
      );
    } finally {
      restoreEnv();
      if (previousAspNetCoreEnvironment === undefined) {
        delete process.env.ASPNETCORE_ENVIRONMENT;
      } else {
        process.env.ASPNETCORE_ENVIRONMENT = previousAspNetCoreEnvironment;
      }
      if (previousNpmConfigPrefix === undefined) {
        delete process.env.NPM_CONFIG_PREFIX;
      } else {
        process.env.NPM_CONFIG_PREFIX = previousNpmConfigPrefix;
      }
      if (previousNpmConfigPrefixLower === undefined) {
        delete process.env.npm_config_prefix;
      } else {
        process.env.npm_config_prefix = previousNpmConfigPrefixLower;
      }
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("accepts an explicit PM2 name identifier without relying on process.env", async () => {
    const setup = await createPm2Fixture();

    try {
      const report = await resolveManagedPm2Environment({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        nameIdentifierValue: "custom01"
      });

      expect(report.nameIdentifier).toBe("custom01");
      expect(report.appName).toBe("fixture-server-custom01");
      expect(report.env.hagicode_instance).toBe("custom01");
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("preserves an inherited ASPNETCORE_ENVIRONMENT for server startup", async () => {
    const restoreNameEnv = setPm2NameIdentifierEnv("fixture");
    const previousAspNetCoreEnvironment = process.env.ASPNETCORE_ENVIRONMENT;
    process.env.ASPNETCORE_ENVIRONMENT = "Development";
    const setup = await createPm2Fixture();

    try {
      const report = await resolveManagedPm2Environment({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server"
      });

      expect(report.env.ASPNETCORE_ENVIRONMENT).toBe("Development");
    } finally {
      restoreNameEnv();
      if (previousAspNetCoreEnvironment === undefined) {
        delete process.env.ASPNETCORE_ENVIRONMENT;
      } else {
        process.env.ASPNETCORE_ENVIRONMENT = previousAspNetCoreEnvironment;
      }
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("resolves released-service server definitions from external absolute paths", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const externalRoot = path.join(
      tmpdir(),
      "hagiscript-external-local-publishment"
    );
    const setup = await createPm2Fixture({
      releasedService: {
        dllPath: path.join(externalRoot, "lib", "PCode.Web.dll"),
        workingDirectory: path.join(externalRoot, "lib")
      }
    });

    try {
      const manifest = await loadRuntimeManifest({
        manifestPath: setup.manifestPath
      });
      const paths = resolveRuntimePaths(manifest, {
        runtimeRoot: setup.runtimeRoot
      });
      const definition = await resolveManagedPm2ServiceDefinition(
        manifest,
        paths,
        "server"
      );

      expect(definition.script).toBe(
        path.join(externalRoot, "lib", "PCode.Web.dll")
      );
      expect(definition.cwd).toBe(path.join(externalRoot, "lib"));
      expect(definition.launchStrategy).toBe("released-service");
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("retries retryable bootstrap PM2 output before returning status", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();
    let jlistCallCount = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
        jlistCallCount += 1;
        if (jlistCallCount === 1) {
          return {
            command,
            args,
            stdout: "",
            stderr:
              "[PM2] PM2 Successfully daemonized\n[PM2] pm2 home=/tmp/.pm2\n"
          };
        }

        if (jlistCallCount === 2) {
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
          };
        }

        return {
          command,
          args,
          stdout: "[]",
          stderr: ""
        };
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: ""
      };
    });

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        action: "start",
        runner
      });

      expect(result.status).toBe("online");
      expect(result.runtimeFilesDir).toBeTruthy();
      expect(jlistCallCount).toBe(2);
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "server",
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
        )
      ]);
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("writes released-service environment into the generated ecosystem config", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();
    let jlistCallCount = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
        jlistCallCount += 1;
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
        };
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: ""
      };
    });

    try {
      await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        action: "start",
        runner
      });

      const ecosystemConfig = await readFile(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "server",
          "pm2-runtime",
          "ecosystem.config.cjs"
        ),
        "utf8"
      );

      expect(ecosystemConfig).toContain("env:");
      expect(ecosystemConfig).toContain(
        '"ASPNETCORE_URLS": "http://127.0.0.1:39150"'
      );
      expect(ecosystemConfig).toContain('"hagicode_instance": "fixture"');
      expect(ecosystemConfig).toContain(
        `script: ${JSON.stringify(
          path.join(
            setup.runtimeRoot,
            "program",
            "components",
            "dotnet",
            "current",
            process.platform === "win32" ? "dotnet.exe" : "dotnet"
          )
        )}`
      );
      expect(ecosystemConfig).toContain(
        `args: ${JSON.stringify([
          path.join(
            setup.runtimeRoot,
            "program",
            "server",
            "versions",
            "1.2.3",
            "lib",
            "PCode.Web.dll"
          )
        ])}`
      );
      expect(ecosystemConfig).toContain("env_file");
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("uses released-service startScript when generating the PM2 ecosystem config", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture({
      releasedService: {
        dllPath: "lib/PCode.Web.dll",
        workingDirectory: "lib",
        startScript: "launcher/server-launcher.mjs"
      }
    });
    let jlistCallCount = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
        jlistCallCount += 1;
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
        };
      }

      return {
        command,
        args,
        stdout: "started",
        stderr: ""
      };
    });

    try {
      await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "server",
        action: "start",
        runner
      });

      const ecosystemConfig = await readFile(
        path.join(
          setup.runtimeRoot,
          "runtime-data",
          "server",
          "pm2-runtime",
          "ecosystem.config.cjs"
        ),
        "utf8"
      );

      expect(ecosystemConfig).toContain(
        `script: ${JSON.stringify(
          path.join(
            setup.runtimeRoot,
            "program",
            "server",
            "versions",
            "1.2.3",
            "launcher",
            "server-launcher.mjs"
          )
        )}`
      );
      expect(ecosystemConfig).toContain(
        `interpreter: ${JSON.stringify(getFixtureNodePath(setup.runtimeRoot))}`
      );
      expect(ecosystemConfig).toContain("args: []");
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("stops managed services by deleting the PM2 app record and tolerates missing apps", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("fixture");
    const setup = await createPm2Fixture();
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (getFixturePm2Subcommand(args) === "jlist") {
        return {
          command,
          args,
          stdout: "[]",
          stderr: ""
        };
      }

      throw new CommandExecutionError(`pm2 ${args[1]} missing`, {
        command,
        args,
        stdout: "",
        stderr:
          "[PM2][ERROR] Process or Namespace fixture-omniroute-fixture not found",
        cwd: setup.runtimeRoot,
        exitCode: 1,
        signal: undefined,
        timedOut: false,
        failed: true
      });
    });

    try {
      const result = await runManagedPm2Command({
        manifestPath: setup.manifestPath,
        runtimeRoot: setup.runtimeRoot,
        service: "omniroute",
        action: "stop",
        runner
      });

      expect(result.exists).toBe(false);
      expect(result.status).toBe("missing");
      expect(result.pid).toBeNull();
      expect(runner).toHaveBeenCalledTimes(3);
      expect(runner.mock.calls[0]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
          "stop",
          "fixture-omniroute-fixture"
        )
      ]);
      expect(runner.mock.calls[1]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(
          setup.runtimeRoot,
          "omniroute",
          "delete",
          "fixture-omniroute-fixture"
        )
      ]);
      expect(runner.mock.calls[2]?.[1]).toEqual([
        ...buildFixturePm2CliArgs(setup.runtimeRoot, "omniroute", "jlist")
      ]);
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("fails PM2 actions early when the required naming identifier is missing", async () => {
    const setup = await createPm2Fixture();
    const runner = vi.fn();
    const previousNameIdentifier = process.env.hagicode_instance;
    delete process.env.hagicode_instance;

    try {
      for (const action of [
        "start",
        "restart",
        "stop",
        "delete",
        "status"
      ] as const) {
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
        );
      }

      await expect(
        resolveManagedPm2Environment({
          manifestPath: setup.manifestPath,
          runtimeRoot: setup.runtimeRoot,
          service: "server"
        })
      ).rejects.toThrow(
        /requires a runtime instance name.*runtime\.hagicodeInstance.*hagicode_instance/
      );
      expect(runner).not.toHaveBeenCalled();
    } finally {
      if (previousNameIdentifier === undefined) {
        delete process.env.hagicode_instance;
      } else {
        process.env.hagicode_instance = previousNameIdentifier;
      }
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("fails PM2 actions early when the resolved naming identifier is invalid", async () => {
    const restoreEnv = setPm2NameIdentifierEnv("Fixture-01");
    const setup = await createPm2Fixture();
    const runner = vi.fn();

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
      );
      await expect(
        resolveManagedPm2Environment({
          manifestPath: setup.manifestPath,
          runtimeRoot: setup.runtimeRoot,
          service: "omniroute"
        })
      ).rejects.toThrow(
        /requires hagicode_instance to use only lowercase letters, digits, and underscores/
      );
      expect(runner).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });
});

async function createPm2Fixture(
  options: {
    releasedService?: {
      dllPath: string;
      workingDirectory: string;
      startScript?: string;
    };
    includePm2HomeOverride?: boolean;
    omitBundledScriptOverride?: boolean;
    omitBundledArgsOverride?: boolean;
    skipManagedNodeByPolicy?: boolean;
  } = {}
): Promise<{
  directory: string;
  manifestPath: string;
  runtimeRoot: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "hagiscript-pm2-"));
  const runtimeRoot = path.join(directory, "managed-runtime");
  const manifestPath = path.join(directory, "manifest.yaml");
  const componentRoot = path.join(
    runtimeRoot,
    "program",
    "components",
    "services",
    "omniroute"
  );
  const codeServerRoot = path.join(
    runtimeRoot,
    "program",
    "components",
    "services",
    "code-server"
  );
  const serverVersionRoot = path.join(
    runtimeRoot,
    "program",
    "server",
    "versions",
    "1.2.3"
  );

  await mkdir(path.join(componentRoot, "current"), { recursive: true });
  await mkdir(path.join(codeServerRoot, "current"), { recursive: true });
  const releasedService = {
    dllPath: options.releasedService?.dllPath ?? "lib/PCode.Web.dll",
    workingDirectory: options.releasedService?.workingDirectory ?? "lib",
    startScript: options.releasedService?.startScript
  };
  const pm2HomeOverrideLine =
    options.includePm2HomeOverride === false ? "" : '      pm2Home: ".pm2"\n';
  const payloadPath = path.isAbsolute(releasedService.dllPath)
    ? releasedService.dllPath
    : path.join(serverVersionRoot, releasedService.dllPath);
  const workingDirectoryPath = path.isAbsolute(releasedService.workingDirectory)
    ? releasedService.workingDirectory
    : path.join(serverVersionRoot, releasedService.workingDirectory);
  const startScriptPath = releasedService.startScript
    ? path.isAbsolute(releasedService.startScript)
      ? releasedService.startScript
      : path.join(serverVersionRoot, releasedService.startScript)
    : undefined;

  await mkdir(workingDirectoryPath, {
    recursive: true
  });
  if (startScriptPath) {
    await mkdir(path.dirname(startScriptPath), { recursive: true });
  }
  await mkdir(path.join(runtimeRoot, "runtime-data", "server"), {
    recursive: true
  });
  await mkdir(path.join(runtimeRoot, "runtime-data", "npm", "bin"), {
    recursive: true
  });
  await mkdir(getFixturePm2EntrypointDirectory(runtimeRoot), {
    recursive: true
  });
  await mkdir(path.join(runtimeRoot, "program", "components", "node", "bin"), {
    recursive: true
  });
  await mkdir(
    path.join(runtimeRoot, "program", "components", "dotnet", "current"),
    {
      recursive: true
    }
  );
  await writeFile(
    path.join(componentRoot, "current", "custom-launcher.mjs"),
    "process.stdout.write('fixture launcher\\n')\n",
    "utf8"
  );
  await mkdir(path.join(componentRoot, "current", "bin"), { recursive: true });
  await writeFile(
    path.join(componentRoot, "current", "bin", "omniroute.mjs"),
    "process.stdout.write('fixture omniroute\\n')\n",
    "utf8"
  );
  await writeFile(
    path.join(componentRoot, "current", "omniroute.sh"),
    "#!/usr/bin/env sh\n",
    "utf8"
  );
  await writeFile(
    path.join(componentRoot, "current", "omniroute.cmd"),
    "@echo off\r\n",
    "utf8"
  );
  await mkdir(
    path.join(
      runtimeRoot,
      "runtime-data",
      "components",
      "services",
      "omniroute",
      "config"
    ),
    {
      recursive: true
    }
  );
  await mkdir(path.join(codeServerRoot, "current", "bin"), { recursive: true });
  await mkdir(path.join(codeServerRoot, "current", "out", "node"), {
    recursive: true
  });
  await writeFile(
    path.join(codeServerRoot, "current", "out", "node", "entry.js"),
    "process.stdout.write('fixture code-server\\n')\n",
    "utf8"
  );
  await writeFile(
    path.join(codeServerRoot, "current", "bin", "code-server"),
    "#!/usr/bin/env sh\n",
    "utf8"
  );
  await writeFile(
    path.join(codeServerRoot, "current", "bin", "code-server.cmd"),
    "@echo off\r\n",
    "utf8"
  );
  await mkdir(
    path.join(
      runtimeRoot,
      "runtime-data",
      "components",
      "services",
      "code-server",
      "config"
    ),
    {
      recursive: true
    }
  );
  await writeFile(
    path.join(
      runtimeRoot,
      "runtime-data",
      "components",
      "services",
      "omniroute",
      "config",
      "config.yaml"
    ),
    "listen: 127.0.0.1:39001\n",
    "utf8"
  );
  await writeFile(
    path.join(
      runtimeRoot,
      "runtime-data",
      "components",
      "services",
      "code-server",
      "config",
      "config.yaml"
    ),
    "bind-addr: 127.0.0.1:8080\n",
    "utf8"
  );
  await writeFile(
    path.join(runtimeRoot, "runtime-data", "npm", "bin", "pm2"),
    "#!/usr/bin/env sh\n",
    "utf8"
  );
  if (process.platform !== "win32") {
    await chmod(
      path.join(componentRoot, "current", "bin", "omniroute.mjs"),
      0o755
    );
    await chmod(path.join(componentRoot, "current", "omniroute.sh"), 0o755);
    await chmod(
      path.join(codeServerRoot, "current", "bin", "code-server"),
      0o755
    );
    await chmod(
      path.join(runtimeRoot, "runtime-data", "npm", "bin", "pm2"),
      0o755
    );
  }
  await writeFile(
    getFixturePm2Entrypoint(runtimeRoot),
    "console.log('pm2 entrypoint');\n",
    "utf8"
  );
  await mkdir(path.dirname(getFixtureExternalNodePath(directory)), {
    recursive: true
  });
  await writeFile(
    getFixtureExternalNodePath(directory),
    "#!/usr/bin/env sh\n",
    "utf8"
  );
  await writeFile(
    getFixtureNodePath(runtimeRoot),
    "#!/usr/bin/env sh\n",
    "utf8"
  );
  await writeFile(payloadPath, "fixture server payload\n", "utf8");
  if (startScriptPath) {
    await writeFile(
      startScriptPath,
      "process.stdout.write('fixture server launcher\\n')\n",
      "utf8"
    );
  }
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
  );
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
  );
  if (process.platform !== "win32") {
    await chmod(getFixturePm2Entrypoint(runtimeRoot), 0o755);
    await chmod(getFixtureExternalNodePath(directory), 0o755);
    await chmod(getFixtureNodePath(runtimeRoot), 0o755);
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
    ).catch(() => undefined);
  }

  const bundledScriptOverride = options.omitBundledScriptOverride
    ? ""
    : '      script: "current/custom-launcher.mjs"\n';
  const bundledArgsOverride = options.omitBundledArgsOverride
    ? ""
    : '      args:\n        - "--port"\n        - "39001"\n';
  const nodeOptionalPolicy = options.skipManagedNodeByPolicy
    ? '    optionalPolicy:\n      rules:\n        - id: "external-managed"\n          dependencyManagementModes: ["external-managed"]\n'
    : "";
  const omniroutePm2Config = `${bundledScriptOverride}${pm2HomeOverrideLine}${bundledArgsOverride}      env:
        RUNTIME_MODE: "fixture"
`;
  const codeServerPm2Config = `${pm2HomeOverrideLine}      env:
        RUNTIME_MODE: "fixture"
`;
  const serverPm2Config = `${pm2HomeOverrideLine}      env:
        ASPNETCORE_URLS: "http://127.0.0.1:39150"
`;
  const releasedServiceStartScriptLine = releasedService.startScript
    ? `      startScript: "${releasedService.startScript.replaceAll("\\", "/")}"\n`
    : "";
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
${nodeOptionalPolicy}  - name: "dotnet"
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
${omniroutePm2Config}
  - name: "server"
    type: "released-service"
    runtimeDataDir: "services/server"
    lifecycleDependencies: ["node", "dotnet"]
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "fixture-server"
      nameIdentifierEnv: "hagicode_instance"
${serverPm2Config}
    releasedService:
      dllPath: "${releasedService.dllPath.replaceAll("\\", "/")}"
      workingDirectory: "${releasedService.workingDirectory.replaceAll("\\", "/")}"
${releasedServiceStartScriptLine}      runtimeFilesDir: "pm2-runtime"
  - name: "code-server"
    type: "bundled-runtime"
    runtimeDataDir: "services/code-server"
    lifecycleDependencies: ["node"]
    installScript: "${fixtureScriptPath.replaceAll("\\", "/")}"
    pm2:
      appName: "fixture-code-server"
      nameIdentifierEnv: "hagicode_instance"
      cwd: "current"
${codeServerPm2Config}
`,
    "utf8"
  );

  return {
    directory,
    manifestPath,
    runtimeRoot
  };
}

function getFixturePm2EntrypointDirectory(runtimeRoot: string): string {
  return process.platform === "win32"
    ? path.join(
        runtimeRoot,
        "runtime-data",
        "npm",
        "node_modules",
        "pm2",
        "bin"
      )
    : path.join(
        runtimeRoot,
        "runtime-data",
        "npm",
        "lib",
        "node_modules",
        "pm2",
        "bin"
      );
}

function getFixturePm2Entrypoint(runtimeRoot: string): string {
  return path.join(getFixturePm2EntrypointDirectory(runtimeRoot), "pm2");
}

function getFixtureExternalNodePath(directory: string): string {
  return path.join(
    directory,
    "external-node",
    process.platform === "win32" ? "node.exe" : "node"
  );
}

function getFixtureNodePath(runtimeRoot: string): string {
  return getRuntimeExecutablePaths(
    path.join(runtimeRoot, "program", "components", "node")
  ).nodePath;
}

function setPm2NameIdentifierEnv(value: string): () => void {
  const previous = process.env.hagicode_instance;
  process.env.hagicode_instance = value;

  return () => {
    if (previous === undefined) {
      delete process.env.hagicode_instance;
      return;
    }

    process.env.hagicode_instance = previous;
  };
}
