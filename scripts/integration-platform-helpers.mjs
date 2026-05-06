import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function executableName(name, platform = process.platform) {
  return platform === "win32" ? `${name}.cmd` : name;
}

export function binCommand(root, name, platform = process.platform) {
  return path.join(
    root,
    "node_modules",
    ".bin",
    executableName(name, platform)
  );
}

export function runtimeNodeCommand(runtimePath, platform = process.platform) {
  const folder = platform === "win32" ? "" : "bin";
  return path.join(
    runtimePath,
    folder,
    platform === "win32" ? "node.exe" : "node"
  );
}

export function runtimeNpmCommand(runtimePath, platform = process.platform) {
  const folder = platform === "win32" ? "" : "bin";
  return path.join(runtimePath, folder, executableName("npm", platform));
}

export function createStageTracker() {
  const stages = [];
  const skipped = [];

  return {
    stages,
    skipped,
    async run(name, action) {
      const startedAt = Date.now();
      const stage = { name, status: "running", durationMs: 0 };
      stages.push(stage);

      try {
        const result = await action();
        stage.status = "passed";
        return result;
      } catch (error) {
        stage.status = "failed";
        stage.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        stage.durationMs = Date.now() - startedAt;
      }
    },
    skip(name, reason) {
      skipped.push({ name, reason });
    }
  };
}

export async function collectPlatformDiagnostics({
  runProcess,
  repoRoot,
  tempRoot,
  packageJsonPath = path.join(repoRoot, "package.json")
}) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const npmVersion = await commandVersion(
    runProcess,
    executableName("npm"),
    ["--version"],
    repoRoot
  );

  return {
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    nodeVersion: process.version,
    npmVersion,
    tempRoot,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    runnerOs: process.env.RUNNER_OS ?? "local",
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    githubRunId: process.env.GITHUB_RUN_ID ?? "local"
  };
}

export function formatDiagnostics(diagnostics) {
  return [
    "Platform diagnostics:",
    `  platform: ${diagnostics.platform}`,
    `  arch: ${diagnostics.arch}`,
    `  os: ${diagnostics.osType} ${diagnostics.osRelease}`,
    `  node: ${diagnostics.nodeVersion}`,
    `  npm: ${diagnostics.npmVersion}`,
    `  tempRoot: ${diagnostics.tempRoot}`,
    `  package: ${diagnostics.packageName}@${diagnostics.packageVersion}`,
    `  runnerOS: ${diagnostics.runnerOs}`,
    `  runnerArch: ${diagnostics.runnerArch}`,
    `  githubRunId: ${diagnostics.githubRunId}`
  ].join("\n");
}

export function formatIntegrationSummary({
  diagnostics,
  stages,
  skipped,
  finalResult,
  extraSections = []
}) {
  const lines = [
    "# Hagiscript Installed Runtime Integration Summary",
    "",
    `- Platform: ${diagnostics.platform}`,
    `- Architecture: ${diagnostics.arch}`,
    `- Runner: ${diagnostics.runnerOs} (${diagnostics.runnerArch})`,
    `- Node.js: ${diagnostics.nodeVersion}`,
    `- npm: ${diagnostics.npmVersion}`,
    `- Temp root: ${diagnostics.tempRoot}`,
    `- Package: ${diagnostics.packageName}@${diagnostics.packageVersion}`,
    `- Final result: ${finalResult}`,
    "",
    "## Stage Outcomes",
    ""
  ];

  for (const stage of stages) {
    const suffix = stage.error ? ` - ${stage.error}` : "";
    lines.push(
      `- ${stage.name}: ${stage.status} (${stage.durationMs}ms)${suffix}`
    );
  }

  lines.push("", "## Skipped Checks", "");

  if (skipped.length === 0) {
    lines.push("- None");
  } else {
    for (const skip of skipped) {
      lines.push(`- ${skip.name}: skipped - ${skip.reason}`);
    }
  }

  for (const section of extraSections) {
    if (!section?.title) {
      continue;
    }

    lines.push("", `## ${section.title}`, "");

    if (Array.isArray(section.lines) && section.lines.length > 0) {
      lines.push(...section.lines);
    } else {
      lines.push("- None");
    }
  }

  return `${lines.join("\n")}\n`;
}

async function commandVersion(runProcess, command, args, cwd) {
  const { stdout } = await runProcess(command, args, { cwd, stdout: "pipe" });
  return stdout.trim();
}
