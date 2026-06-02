#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parse, stringify } from "yaml";
import {
  collectPlatformDiagnostics,
  createStageTracker,
  formatDiagnostics,
  formatIntegrationSummary,
  normalizeIntegrationRuntimeComponent
} from "./integration-platform-helpers.mjs";
import { collectManagedPm2FailureDetail } from "./integration-pm2-diagnostics.mjs";
import { ProcessRunError, runProcess } from "./process-runner.mjs";
import { extractZipArchive as extractZipArchiveWithNode } from "../runtime/lib/zip-extract.mjs";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "hagiscript-runtime-key-path-")
);
const tracker = createStageTracker();
const manifestPath = path.join(repoRoot, "runtime", "manifest.yaml");
const managedRoot = path.join(tempRoot, "managed-runtime");
const runtimeManifestPath = path.join(
  tempRoot,
  "runtime-key-path-manifest.yaml"
);
const pm2RuntimeManifestPath = path.join(
  tempRoot,
  "runtime-key-path-pm2-manifest.yaml"
);
const toolManifestPath = path.join(tempRoot, "runtime-key-path-tools.json");
const summaryPath = path.join(tempRoot, "runtime-key-path-summary.md");
const runtimeCommandTimeoutMs = 20 * 60_000;
const pm2CommandTimeoutMs = 5 * 60_000;
const pm2NameIdentifier = "keypath";
const bundledRuntimeComponentsForPm2 = "omniroute,code-server";
const enableReleasedServerTest =
  process.env.HAGISCRIPT_ENABLE_RELEASED_SERVER_TEST === "1";
let diagnostics;
let finalResult = "failed";
const runtimeInstallLines = [];
const npmSyncLines = [];
const pm2EnvironmentLines = [];
const dedicatedCommandLines = [];
const dedicatedCommandFailureLines = [];
const dedicatedCommandFailureDetails = [];
const pm2LifecycleLines = [];
const pm2FailureLines = [];
const pm2FailureDetails = [];
const releasedServerLines = [];

try {
  process.env.hagicode_pm2_name = pm2NameIdentifier;
  diagnostics = await runStage("platform diagnostics", async () => {
    const collected = await collectPlatformDiagnostics({
      runProcess,
      repoRoot,
      tempRoot
    });
    log(formatDiagnostics(collected));
    return collected;
  });

  await runStage("prepare key-path manifest", async () => {
    const manifest = parse(fs.readFileSync(manifestPath, "utf8"));
    const manifestDirectory = path.dirname(manifestPath);
    fs.cpSync(
      path.join(manifestDirectory, "templates"),
      path.join(tempRoot, "templates"),
      {
        recursive: true
      }
    );
    const componentNames = new Set(
      enableReleasedServerTest
        ? ["node", "dotnet", "server", "omniroute", "code-server"]
        : ["node", "omniroute", "code-server"]
    );
    const releasedServerPort = enableReleasedServerTest
      ? await getAvailablePort()
      : null;
    manifest.paths.runtimeDataRoot = "runtime-data";
    manifest.paths.serverDataRoot = "runtime-data/server";

    manifest.components = manifest.components
      .filter((component) => componentNames.has(component.name))
      .map((component) => {
        const normalizedComponent = normalizeIntegrationRuntimeComponent(
          component,
          manifestDirectory
        );

        if (component.pm2 && isManagedPm2Service(component.name)) {
          normalizedComponent.pm2 = {
            ...component.pm2,
            ...(component.name === "server" && releasedServerPort
              ? {
                  env: {
                    ...(component.pm2.env ?? {}),
                    ASPNETCORE_URLS: `http://127.0.0.1:${releasedServerPort}`
                  }
                }
              : {}),
            pm2Home: getIntegrationPm2Home(tempRoot, component.name)
          };
        }

        return normalizedComponent;
      });

    for (const phaseName of ["install", "remove", "update"]) {
      manifest.phases[phaseName].order = manifest.phases[
        phaseName
      ].order.filter((name) => componentNames.has(name));
    }

    fs.writeFileSync(runtimeManifestPath, stringify(manifest), "utf8");

    const pm2Manifest = {
      ...manifest,
      components: manifest.components.map((component) => {
        if (!isBundledRuntimeService(component.name)) {
          return component;
        }

        return {
          ...component,
          bundledInstallMode: "extract"
        };
      })
    };

    fs.writeFileSync(pm2RuntimeManifestPath, stringify(pm2Manifest), "utf8");
    fs.writeFileSync(
      toolManifestPath,
      `${JSON.stringify(
        {
          packages: {
            pm2: { version: "7.0.1", target: "pm2@7.0.1" },
            skills: { version: "1.5.1", target: "skills@1.5.1" },
            openspec: { version: "1.3.1", target: "@fission-ai/openspec@1.3.1" }
          }
        },
        null,
        2
      )}
`,
      "utf8"
    );
  });

  await runStage("runtime install", async () => {
    const installOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "install",
        "--from-manifest",
        runtimeManifestPath,
        "--runtime-root",
        managedRoot
      ],
      repoRoot
    );

    assertIncludes(
      installOutput,
      "Runtime install complete.",
      "runtime install output"
    );

    const stateOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "state",
        "--from-manifest",
        runtimeManifestPath,
        "--runtime-root",
        managedRoot,
        "--json"
      ],
      repoRoot
    );
    const report = JSON.parse(stateOutput);
    const componentNames = report.components.map(
      (item) => `${item.name}:${item.status}`
    );
    const omnirouteArchive = path.join(
      managedRoot,
      "program",
      "components",
      "bundled",
      "omniroute",
      "archives",
      "omniroute.7z"
    );
    const codeServerArchive = path.join(
      managedRoot,
      "program",
      "components",
      "bundled",
      "code-server",
      "archives",
      "code-server.7z"
    );
    const omnirouteBin = path.join(
      managedRoot,
      "program",
      "bin",
      process.platform === "win32" ? "omniroute.cmd" : "omniroute"
    );
    const codeServerBin = path.join(
      managedRoot,
      "program",
      "bin",
      process.platform === "win32" ? "code-server.cmd" : "code-server"
    );
    const omnirouteCurrentRoot = path.join(
      managedRoot,
      "program",
      "components",
      "bundled",
      "omniroute",
      "current"
    );
    const codeServerCurrentRoot = path.join(
      managedRoot,
      "program",
      "components",
      "bundled",
      "code-server",
      "current"
    );
    const omnirouteMarkerPath = path.join(
      managedRoot,
      "program",
      "components",
      "bundled",
      "omniroute",
      ".hagicode-runtime.json"
    );
    const codeServerMarkerPath = path.join(
      managedRoot,
      "program",
      "components",
      "bundled",
      "code-server",
      ".hagicode-runtime.json"
    );

    assertMissingPath(codeServerArchive);
    assertMissingPath(omnirouteArchive);
    assertMissingPath(omnirouteBin);
    assertMissingPath(codeServerBin);
    assertMissingPath(omnirouteCurrentRoot);
    assertMissingPath(codeServerCurrentRoot);
    assertMissingPath(omnirouteMarkerPath);
    assertMissingPath(codeServerMarkerPath);

    runtimeInstallLines.push(
      `- Managed root: ${managedRoot}`,
      `- Program home: ${path.join(managedRoot, "program")}`,
      `- Runtime data root: ${path.join(managedRoot, "runtime-data")}`,
      `- Managed npm prefix reserved path: ${path.join(managedRoot, "program", "npm")}`,
      `- Installed components: ${componentNames.join(", ")}`,
      `- Omniroute optional archive not installed by default: ${omnirouteArchive}`,
      `- Code-server optional archive not installed by default: ${codeServerArchive}`,
      "- Verified default bundled runtime install leaves optional omniroute and code-server uninstalled"
    );
  });

  await runStage("npm-sync tool installation", async () => {
    const npmSyncOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "npm-sync",
        "--runtime",
        path.join(managedRoot, "program", "components", "node", "runtime"),
        "--prefix",
        path.join(managedRoot, "program", "npm"),
        "--manifest",
        toolManifestPath
      ],
      repoRoot
    );

    assertIncludes(npmSyncOutput, "npm-sync complete.", "npm-sync output");
    assertIncludes(npmSyncOutput, "Plan: pm2 install", "pm2 install plan");
    assertIncludes(
      npmSyncOutput,
      "Plan: skills install",
      "skills install plan"
    );
    assertIncludes(
      npmSyncOutput,
      "Plan: openspec install",
      "openspec install plan"
    );

    npmSyncLines.push(
      `- Prefix: ${path.join(managedRoot, "program", "npm")}`,
      `- Manifest: ${toolManifestPath}`,
      "- Installed tooling through npm-sync: pm2, skills, @fission-ai/openspec"
    );
  });

  await runStage("dedicated component command lifecycle", async () => {
    const optionalInstallOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "install",
        "--from-manifest",
        runtimeManifestPath,
        "--runtime-root",
        managedRoot,
        "--components",
        "omniroute,code-server"
      ],
      repoRoot
    );
    assertIncludes(
      optionalInstallOutput,
      "Runtime install complete.",
      "optional bundled runtime archive install output"
    );

    await prepareBundledServiceConfigs(managedRoot);

    const components = [
      {
        command: "omniroute",
        service: "omniroute",
        version: "3.6.9",
        currentRoot: path.join(
          managedRoot,
          "runtime-data",
          "runtimeComponents",
          "omniroute",
          "3.6.9",
          "current"
        ),
        entrypoint: path.join("bin", "omniroute.mjs"),
        logPath: path.join(
          managedRoot,
          "runtime-data",
          "components",
          "services",
          "omniroute",
          "logs",
          "omniroute.log"
        )
      },
      {
        command: "code_server",
        service: "code-server",
        version: "4.117.0",
        currentRoot: path.join(
          managedRoot,
          "runtime-data",
          "runtimeComponents",
          "code_server",
          "4.117.0",
          "current"
        ),
        entrypoint: path.join("out", "node", "entry.js"),
        logPath: path.join(
          managedRoot,
          "runtime-data",
          "components",
          "services",
          "code-server",
          "logs",
          "code-server.log"
        )
      }
    ];

    try {
      for (const component of components) {
        try {
          const exactOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              component.command,
              "exact",
              "--from-manifest",
              runtimeManifestPath,
              "--runtime-root",
              managedRoot
            ],
            repoRoot
          );
          assertIncludes(
            exactOutput,
            "Action: exact",
            `${component.command} exact`
          );
          assertIncludes(
            exactOutput,
            `Extracted runtime: ${path.dirname(component.currentRoot)}`,
            `${component.command} extracted runtime root`
          );
          assertIncludes(
            exactOutput,
            `Current root: ${component.currentRoot}`,
            `${component.command} current root`
          );
          assertFile(path.join(component.currentRoot, component.entrypoint));

          const missingOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              component.command,
              "status",
              "--from-manifest",
              runtimeManifestPath,
              "--runtime-root",
              managedRoot
            ],
            repoRoot
          );
          assertIncludes(
            missingOutput,
            "Status: missing",
            `${component.command} missing status`
          );

          const startOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              component.command,
              "start",
              "--from-manifest",
              runtimeManifestPath,
              "--runtime-root",
              managedRoot
            ],
            repoRoot
          );
          assertIncludes(
            startOutput,
            "Action: start",
            `${component.command} start`
          );

          const statusOutput = await waitForDedicatedComponentStatus(
            component.command,
            "online",
            {
              manifestPath: runtimeManifestPath,
              runtimeRoot: managedRoot,
              repoRoot
            }
          );
          assertIncludes(
            statusOutput,
            "Status: online",
            `${component.command} online status`
          );

          const logsOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              component.command,
              "logs",
              "--from-manifest",
              runtimeManifestPath,
              "--runtime-root",
              managedRoot,
              "--lines",
              "20"
            ],
            repoRoot
          );
          assertIncludes(
            logsOutput,
            "Action: logs",
            `${component.command} logs`
          );
          assertIncludes(
            logsOutput,
            `Target path: ${component.logPath}`,
            `${component.command} logs target`
          );

          const stopOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              component.command,
              "stop",
              "--from-manifest",
              runtimeManifestPath,
              "--runtime-root",
              managedRoot
            ],
            repoRoot
          );
          assertIncludes(
            stopOutput,
            "Status: missing",
            `${component.command} stop`
          );
          dedicatedCommandLines.push(
            `- ${component.command}: exact -> extracted ${component.version} runtime -> start -> online -> logs -> stop -> missing`
          );
        } catch (error) {
          const detail = await collectManagedPm2FailureDetail({
            runProcess,
            repoRoot,
            runtimeRoot: managedRoot,
            manifestPath: runtimeManifestPath,
            tempRoot,
            service: component.service,
            reason: error instanceof Error ? error.message : String(error)
          });
          dedicatedCommandFailureLines.push(
            `- ${component.command}: failed, diagnostics captured in folded details below`
          );
          dedicatedCommandFailureDetails.push(detail);
          log(
            `Collected dedicated component command diagnostics for ${component.command}`
          );
          throw error;
        }
      }
    } finally {
      await Promise.all([
        killManagedPm2(managedRoot, "omniroute"),
        killManagedPm2(managedRoot, "code-server")
      ]);
    }
  });

  await runStage("runtime install for PM2 validation", async () => {
    const installOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "runtime",
        "install",
        "--from-manifest",
        pm2RuntimeManifestPath,
        "--runtime-root",
        managedRoot,
        "--components",
        bundledRuntimeComponentsForPm2
      ],
      repoRoot
    );

    assertIncludes(
      installOutput,
      "Runtime install complete.",
      "runtime install for PM2 validation output"
    );
    assertFile(
      path.join(
        managedRoot,
        "program",
        "bin",
        process.platform === "win32" ? "omniroute.cmd" : "omniroute"
      )
    );
    assertFile(
      path.join(
        managedRoot,
        "program",
        "bin",
        process.platform === "win32" ? "code-server.cmd" : "code-server"
      )
    );
    runtimeInstallLines.push(
      "- Reinstalled bundled runtimes with extract mode override for PM2 lifecycle validation"
    );
  });

  await runStage("pm2 environment contract", async () => {
    const envOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "pm2",
        "omniroute",
        "env",
        "--from-manifest",
        pm2RuntimeManifestPath,
        "--runtime-root",
        managedRoot
      ],
      repoRoot
    );

    assertIncludes(envOutput, "Service: omniroute", "pm2 env service");
    assertIncludes(
      envOutput,
      `PM2 binary: ${getFixturePm2Entrypoint(managedRoot)}`,
      "pm2 env binary"
    );
    assertIncludes(
      envOutput,
      `PM2 home: ${getIntegrationPm2Home(tempRoot, "omniroute")}`,
      "pm2 env home"
    );
    assertIncludes(
      envOutput,
      `Runtime data home: ${path.join(managedRoot, "runtime-data", "components", "services", "omniroute")}`,
      "pm2 env runtime data"
    );

    pm2EnvironmentLines.push(
      "- Command: `hagiscript pm2 omniroute env --from-manifest <manifest> --runtime-root <managed-root>`",
      "```text",
      ...envOutput.trimEnd().split(/\r?\n/u),
      "```"
    );
  });

  await runStage("pm2 managed service lifecycle", async () => {
    await prepareBundledServiceConfigs(managedRoot);

    try {
      for (const service of ["omniroute", "code-server"]) {
        try {
          const missingOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              "pm2",
              service,
              "status",
              "--from-manifest",
              pm2RuntimeManifestPath,
              "--runtime-root",
              managedRoot
            ],
            repoRoot
          );
          assertIncludes(
            missingOutput,
            "Status: missing",
            `${service} missing status`
          );

          const startOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              "pm2",
              service,
              "start",
              "--from-manifest",
              pm2RuntimeManifestPath,
              "--runtime-root",
              managedRoot
            ],
            repoRoot
          );
          assertIncludes(startOutput, "Action: start", `${service} start`);

          const statusOutput = await waitForManagedPm2Status(
            service,
            "online",
            {
              manifestPath: pm2RuntimeManifestPath,
              runtimeRoot: managedRoot,
              repoRoot
            }
          );

          assertIncludes(
            statusOutput,
            "Status: online",
            `${service} online status`
          );

          const stopOutput = await runCapture(
            process.execPath,
            [
              "dist/cli.js",
              "pm2",
              service,
              "stop",
              "--from-manifest",
              pm2RuntimeManifestPath,
              "--runtime-root",
              managedRoot
            ],
            repoRoot
          );
          assertIncludes(stopOutput, "Status: missing", `${service} stop`);
          pm2LifecycleLines.push(
            `- ${service}: start -> online -> stop -> missing`
          );
        } catch (error) {
          const detail = await collectManagedPm2FailureDetail({
            runProcess,
            repoRoot,
            runtimeRoot: managedRoot,
            manifestPath: pm2RuntimeManifestPath,
            tempRoot,
            service,
            reason: error instanceof Error ? error.message : String(error)
          });
          pm2FailureLines.push(
            `- ${service}: failed, diagnostics captured in folded details below`
          );
          pm2FailureDetails.push(detail);
          log(`Collected managed PM2 failure diagnostics for ${service}`);
          throw error;
        }
      }
    } finally {
      await Promise.all([
        killManagedPm2(managedRoot, "omniroute"),
        killManagedPm2(managedRoot, "code-server")
      ]);
    }
  });

  if (enableReleasedServerTest) {
    await runStage("released server key-path", async () => {
      const releasedServer = await prepareReleasedServerPayload({
        managedRoot,
        repoRoot,
        tempRoot
      });

      const installOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "server",
          "install",
          "--from-manifest",
          pm2RuntimeManifestPath,
          "--runtime-root",
          managedRoot,
          "--archive",
          releasedServer.archivePath
        ],
        repoRoot
      );
      assertIncludes(
        installOutput,
        "Server install complete.",
        "server runtime install"
      );
      const listOutput = await runCapture(
        process.execPath,
        [
          "dist/cli.js",
          "server",
          "list",
          "--from-manifest",
          pm2RuntimeManifestPath,
          "--runtime-root",
          managedRoot,
          "--json"
        ],
        repoRoot
      );
      const listReport = JSON.parse(listOutput);
      if (!listReport.activeVersion) {
        throw new Error(
          `Expected server install to activate a version. Output:\n${listOutput}`
        );
      }

      try {
        const startOutput = await runCapture(
          process.execPath,
          [
            "dist/cli.js",
            "pm2",
            "server",
            "start",
            "--from-manifest",
            pm2RuntimeManifestPath,
            "--runtime-root",
            managedRoot
          ],
          repoRoot
        );
        assertIncludes(startOutput, "Action: start", "server start");

        const statusOutput = await waitForManagedPm2Status("server", "online", {
          manifestPath: pm2RuntimeManifestPath,
          runtimeRoot: managedRoot,
          repoRoot
        });

        assertIncludes(statusOutput, "Status: online", "server online status");

        releasedServerLines.push(
          `- Release tag: ${releasedServer.tagName}`,
          `- Asset: ${releasedServer.assetName}`,
          `- Archive: ${releasedServer.archivePath}`,
          `- Active version: ${listReport.activeVersion}`,
          "- Lifecycle: server install -> npm-sync provisioned pm2 -> pm2 start -> online"
        );
      } finally {
        await killManagedPm2(managedRoot, "server");
      }
    });
  }

  finalResult = "passed";
  log("Runtime key-path integration test passed");
} finally {
  const fallbackDiagnostics = diagnostics ?? {
    platform: process.platform,
    arch: process.arch,
    runnerOs: process.env.RUNNER_OS ?? "local",
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    nodeVersion: process.version,
    npmVersion: "unknown",
    tempRoot,
    packageName: "hagiscript",
    packageVersion: "unknown"
  };

  const summary = formatIntegrationSummary({
    title: "Hagiscript Runtime Key Path Integration Summary",
    diagnostics: fallbackDiagnostics,
    stages: tracker.stages,
    skipped: tracker.skipped,
    finalResult,
    extraSections: [
      {
        title: "Runtime Install",
        lines:
          runtimeInstallLines.length > 0
            ? runtimeInstallLines
            : ["- Not captured"]
      },
      {
        title: "npm-sync Provisioning",
        lines: npmSyncLines.length > 0 ? npmSyncLines : ["- Not captured"]
      },
      {
        title: "Dedicated Component Commands",
        lines: [
          ...(dedicatedCommandLines.length > 0 ? dedicatedCommandLines : []),
          ...(dedicatedCommandFailureLines.length > 0
            ? dedicatedCommandFailureLines
            : []),
          ...(dedicatedCommandLines.length === 0 &&
          dedicatedCommandFailureLines.length === 0
            ? ["- Not captured"]
            : [])
        ],
        details: dedicatedCommandFailureDetails
      },
      {
        title: "Managed PM2 Verification",
        lines: [
          ...(pm2LifecycleLines.length > 0 ? pm2LifecycleLines : []),
          ...(pm2FailureLines.length > 0 ? pm2FailureLines : []),
          ...(pm2LifecycleLines.length === 0 && pm2FailureLines.length === 0
            ? ["- Not captured"]
            : []),
          releasedServerLines.length > 0
            ? "- Released server validation: captured in folded details below"
            : "- Released server validation: not requested"
        ],
        details: [
          {
            summary: "PM2 environment contract",
            lines:
              pm2EnvironmentLines.length > 0
                ? pm2EnvironmentLines
                : ["- Not captured"]
          },
          ...pm2FailureDetails,
          ...(releasedServerLines.length > 0
            ? [
                {
                  summary: "Released server validation",
                  lines: releasedServerLines
                }
              ]
            : [])
        ]
      }
    ]
  });

  fs.writeFileSync(summaryPath, summary);
  process.stdout.write(`\n${summary}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}`);
  }

  if (process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH) {
    fs.mkdirSync(
      path.dirname(process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH),
      {
        recursive: true
      }
    );
    fs.copyFileSync(
      summaryPath,
      process.env.HAGISCRIPT_INTEGRATION_SUMMARY_PATH
    );
  }

  if (process.env.HAGISCRIPT_KEEP_INTEGRATION_TEMP !== "1") {
    await cleanupTempRoot(tempRoot);
  } else {
    log(`Keeping integration temp directory: ${tempRoot}`);
  }
}

async function runCapture(command, args, cwd) {
  const timeoutMs = isPm2Command(args)
    ? pm2CommandTimeoutMs
    : runtimeCommandTimeoutMs;
  log(
    `Running command: ${formatCommand(command, args)} (timeout=${timeoutMs}ms)`
  );

  try {
    const { stdout, stderr } = await runProcess(command, args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs
    });
    log(
      `Command completed: ${formatCommand(command, args)}${formatOutputSummary(stdout, stderr)}`
    );
    return stdout;
  } catch (error) {
    if (error instanceof ProcessRunError) {
      throw new Error(formatProcessFailure(error), { cause: error });
    }

    throw error;
  }
}

async function waitForManagedPm2Status(service, expectedStatus, options) {
  const attempts = process.platform === "linux" ? 3 : 6;
  let lastOutput = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        "pm2",
        service,
        "status",
        "--from-manifest",
        options.manifestPath,
        "--runtime-root",
        options.runtimeRoot
      ],
      options.repoRoot
    );

    if (lastOutput.includes(`Status: ${expectedStatus}`)) {
      return lastOutput;
    }

    if (attempt < attempts) {
      await delay(500 * attempt);
    }
  }

  return lastOutput;
}

async function waitForDedicatedComponentStatus(
  component,
  expectedStatus,
  options
) {
  const attempts = process.platform === "linux" ? 3 : 6;
  let lastOutput = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastOutput = await runCapture(
      process.execPath,
      [
        "dist/cli.js",
        component,
        "status",
        "--from-manifest",
        options.manifestPath,
        "--runtime-root",
        options.runtimeRoot
      ],
      options.repoRoot
    );

    if (lastOutput.includes(`Status: ${expectedStatus}`)) {
      return lastOutput;
    }

    if (attempt < attempts) {
      await delay(500 * attempt);
    }
  }

  return lastOutput;
}

async function prepareBundledServiceConfigs(runtimeRoot) {
  const omnirouteConfigPath = path.join(
    runtimeRoot,
    "runtime-data",
    "components",
    "services",
    "omniroute",
    "config",
    "config.yaml"
  );
  if (fs.existsSync(omnirouteConfigPath)) {
    const port = await getAvailablePort();
    const current = fs.readFileSync(omnirouteConfigPath, "utf8");
    fs.writeFileSync(
      omnirouteConfigPath,
      current.replace(
        /listen:\s*"?127\.0\.0\.1:\d+"?/u,
        `listen: "127.0.0.1:${port}"`
      ),
      "utf8"
    );
    log(`Prepared omniroute PM2 config with dynamic port ${port}`);
  }

  const codeServerConfigPath = path.join(
    runtimeRoot,
    "runtime-data",
    "components",
    "services",
    "code-server",
    "config",
    "config.yaml"
  );
  if (fs.existsSync(codeServerConfigPath)) {
    const port = await getAvailablePort();
    const current = fs.readFileSync(codeServerConfigPath, "utf8");
    fs.writeFileSync(
      codeServerConfigPath,
      current.replace(
        /bind-addr:\s*"?127\.0\.0\.1:\d+"?/u,
        `bind-addr: 127.0.0.1:${port}`
      ),
      "utf8"
    );
    log(`Prepared code-server PM2 config with dynamic port ${port}`);
  }
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(
            new Error("Expected a TCP address when reserving a free port.")
          )
        );
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function assertIncludes(output, expected, label) {
  if (!output.includes(expected)) {
    throw new Error(
      `Expected ${label} to include ${expected}. Output:\n${output}`
    );
  }
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
}

function assertMissingPath(targetPath) {
  if (fs.existsSync(targetPath)) {
    throw new Error(`Expected path to be absent: ${targetPath}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function prepareReleasedServerPayload(options) {
  const releaseRepository =
    process.env.HAGISCRIPT_RELEASED_SERVER_REPOSITORY?.trim() ||
    "HagiCode-org/releases";
  const assetSuffix = getReleasedServerAssetSuffix();
  const releaseResponse = await globalThis.fetch(
    `https://api.github.com/repos/${releaseRepository}/releases/latest`,
    {
      headers: buildGitHubRequestHeaders("application/vnd.github+json")
    }
  );

  if (!releaseResponse.ok) {
    throw new Error(
      `Failed to read latest released server metadata: HTTP ${releaseResponse.status}`
    );
  }

  const release = await releaseResponse.json();
  const asset = Array.isArray(release.assets)
    ? release.assets.find(
        (entry) =>
          typeof entry?.name === "string" && entry.name.endsWith(assetSuffix)
      )
    : null;

  if (!asset?.browser_download_url || !asset?.name || !release.tag_name) {
    throw new Error(
      `Latest release in ${releaseRepository} does not expose a ${assetSuffix} asset.`
    );
  }

  const archivePath = path.join(options.tempRoot, asset.name);
  const extractRoot = path.join(options.tempRoot, "released-server");
  await downloadFile(asset.browser_download_url, archivePath);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });
  await extractZipArchive(archivePath, extractRoot, options.repoRoot);
  const dllPath = path.join(extractRoot, "lib", "PCode.Web.dll");
  if (!fs.existsSync(dllPath)) {
    throw new Error(`Expected released server payload to contain ${dllPath}`);
  }

  return {
    tagName: release.tag_name,
    assetName: asset.name,
    archivePath,
    extractRoot,
    dllPath
  };
}

async function downloadFile(url, destinationPath) {
  const response = await globalThis.fetch(url, {
    headers: buildGitHubRequestHeaders()
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destinationPath, globalThis.Buffer.from(arrayBuffer));
}

async function extractZipArchive(archivePath, extractRoot, cwd) {
  void cwd;

  try {
    await extractZipArchiveWithNode(archivePath, extractRoot);
  } catch (error) {
    const archiveError =
      error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `Failed to extract released server archive ${archivePath}: ${archiveError.message}`
    );
  }
}

function getReleasedServerAssetSuffix() {
  const platform = getReleasedServerPlatform();
  const arch = getReleasedServerArch();
  return `${platform}-${arch}-nort.zip`;
}

function getReleasedServerPlatform() {
  switch (process.platform) {
    case "darwin":
      return "osx";
    case "win32":
      return "win";
    default:
      return "linux";
  }
}

function getReleasedServerArch() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(
        `Released server validation does not support architecture ${process.arch}.`
      );
  }
}

function buildGitHubRequestHeaders(accept = "application/octet-stream") {
  const headers = {
    Accept: accept,
    "User-Agent": "hagiscript-runtime-key-path-integration"
  };
  const token =
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.HAGISCRIPT_GITHUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function getFixturePm2Entrypoint(runtimeRoot) {
  return process.platform === "win32"
    ? path.join(
        runtimeRoot,
        "runtime-data",
        "npm",
        "node_modules",
        "pm2",
        "bin",
        "pm2"
      )
    : path.join(
        runtimeRoot,
        "runtime-data",
        "npm",
        "lib",
        "node_modules",
        "pm2",
        "bin",
        "pm2"
      );
}

async function killManagedPm2(runtimeRoot, serviceName) {
  const pm2Home = getIntegrationPm2Home(tempRoot, serviceName);
  if (!fs.existsSync(pm2Home)) {
    return;
  }

  const env = {
    ...process.env,
    PM2_HOME: pm2Home,
    HAGISCRIPT_DISABLE_EXECA: "1"
  };
  const nodePath = path.join(
    runtimeRoot,
    "program",
    "components",
    "node",
    "runtime",
    process.platform === "win32" ? "node.exe" : "bin/node"
  );

  try {
    await runProcess(nodePath, [getFixturePm2Entrypoint(runtimeRoot), "kill"], {
      cwd: repoRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: pm2CommandTimeoutMs
    });
  } catch {
    return;
  }
}

function formatCommand(command, args) {
  return [command, ...args].map((entry) => JSON.stringify(entry)).join(" ");
}

function formatOutputSummary(stdout, stderr) {
  const lines = [];
  if (stdout?.trim()) {
    lines.push(` stdout=${truncateOutput(stdout.trim())}`);
  }
  if (stderr?.trim()) {
    lines.push(` stderr=${truncateOutput(stderr.trim())}`);
  }
  return lines.join("");
}

function formatProcessFailure(error) {
  return [
    `Command failed: ${formatCommand(error.result.command, error.result.args)}`,
    `Exit code: ${error.result.exitCode ?? "null"}`,
    error.result.signal ? `Signal: ${error.result.signal}` : "",
    error.stdout?.trim() ? `stdout:\n${error.stdout.trim()}` : "",
    error.stderr?.trim() ? `stderr:\n${error.stderr.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateOutput(value, maxLength = 240) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

async function cleanupTempRoot(directory) {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

async function runStage(name, action) {
  log(`Starting stage: ${name}`);
  const result = await tracker.run(name, action);
  log(`Completed stage: ${name}`);
  return result;
}

function isManagedPm2Service(serviceName) {
  return (
    serviceName === "omniroute" ||
    serviceName === "code-server" ||
    serviceName === "server"
  );
}

function isBundledRuntimeService(serviceName) {
  return serviceName === "omniroute" || serviceName === "code-server";
}

function getIntegrationPm2Home(tempRootPath, serviceName) {
  return path.join(tempRootPath, "p", getManagedPm2ServiceKey(serviceName));
}

function getManagedPm2ServiceKey(serviceName) {
  switch (serviceName) {
    case "server":
      return "s";
    case "omniroute":
      return "o";
    case "code-server":
      return "c";
    default:
      return serviceName;
  }
}

function isPm2Command(args) {
  return args.includes("pm2");
}

function log(message) {
  process.stdout.write(`${message}\n`);
}
