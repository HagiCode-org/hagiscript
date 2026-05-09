import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { executableName } from "./integration-platform-helpers.mjs";

export async function collectManagedPm2FailureDetail({
  runProcess,
  repoRoot,
  runtimeRoot,
  manifestPath,
  tempRoot,
  service,
  reason,
  cliEntry = "dist/cli.js",
  pm2CommandTimeoutMs = 60_000
}) {
  const envCapture = await captureCommand(
    runProcess,
    process.execPath,
    [
      cliEntry,
      "pm2",
      service,
      "env",
      "--from-manifest",
      manifestPath,
      "--runtime-root",
      runtimeRoot
    ],
    {
      cwd: repoRoot,
      timeoutMs: pm2CommandTimeoutMs
    }
  );
  const envOutput = envCapture.stdout || envCapture.stderr;
  const appName =
    extractPrefixedLine(envOutput, "App: ") ??
    `hagicode-${service}-${process.env.hagicode_pm2_name?.trim() || "hagicode"}`;
  const pm2Home =
    extractPrefixedLine(envOutput, "PM2 home: ") ??
    path.join(tempRoot, `.pm2-${service}`);
  const runtimeDataHome =
    extractPrefixedLine(envOutput, "Runtime data home: ") ??
    path.join(runtimeRoot, "runtime-data", "components", "services", service);
  const configPath = path.join(runtimeDataHome, "config", "config.yaml");
  const componentLogsDir = path.join(runtimeDataHome, "logs");
  const wrapperPath = path.join(
    runtimeRoot,
    "program",
    "bin",
    executableName(service)
  );
  const nodePath = path.join(
    runtimeRoot,
    "program",
    "components",
    "node",
    "runtime",
    process.platform === "win32" ? "node.exe" : "bin/node"
  );
  const pm2Entrypoint = getManagedPm2Entrypoint(runtimeRoot);
  const pm2Env = {
    ...process.env,
    PM2_HOME: pm2Home,
    HAGISCRIPT_DISABLE_EXECA: "1"
  };

  const [statusCapture, describeCapture, jlistCapture, wrapperCapture] =
    await Promise.all([
      captureCommand(
        runProcess,
        process.execPath,
        [
          cliEntry,
          "pm2",
          service,
          "status",
          "--from-manifest",
          manifestPath,
          "--runtime-root",
          runtimeRoot
        ],
        {
          cwd: repoRoot,
          timeoutMs: pm2CommandTimeoutMs
        }
      ),
      captureCommand(
        runProcess,
        nodePath,
        [pm2Entrypoint, "describe", appName],
        {
          cwd: repoRoot,
          env: pm2Env,
          timeoutMs: pm2CommandTimeoutMs
        }
      ),
      captureCommand(runProcess, nodePath, [pm2Entrypoint, "jlist"], {
        cwd: repoRoot,
        env: pm2Env,
        timeoutMs: pm2CommandTimeoutMs
      }),
      captureCommand(
        runProcess,
        getWrapperSmokeCommand(wrapperPath).command,
        getWrapperSmokeCommand(wrapperPath).args,
        {
          cwd: repoRoot,
          timeoutMs: 30_000
        }
      )
    ]);

  const detailLines = [
    `- Failure: ${normalizeInlineText(reason)}`,
    `- Service: ${service}`,
    `- App: ${appName}`,
    `- Wrapper: ${wrapperPath}`,
    `- PM2 home: ${pm2Home}`,
    `- Config path: ${configPath}`,
    `- Component logs dir: ${componentLogsDir}`
  ];

  appendCommandBlock(detailLines, "hagiscript pm2 env", envCapture);
  appendCommandBlock(detailLines, "hagiscript pm2 status", statusCapture);
  appendCommandBlock(detailLines, `pm2 describe ${appName}`, describeCapture);
  appendCommandBlock(detailLines, "pm2 jlist", jlistCapture);
  appendCommandBlock(
    detailLines,
    `wrapper smoke: ${service} --help`,
    wrapperCapture
  );
  appendFileBlock(detailLines, `rendered config (${configPath})`, configPath);
  appendDirectoryBlock(
    detailLines,
    `PM2 logs (${path.join(pm2Home, "logs")})`,
    path.join(pm2Home, "logs")
  );
  appendDirectoryBlock(
    detailLines,
    `component logs (${componentLogsDir})`,
    componentLogsDir
  );

  return {
    summary: `${service} failure diagnostics`,
    lines: detailLines
  };
}

async function captureCommand(runProcess, command, args, options) {
  try {
    const result = await runProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: options.timeoutMs
    });

    return {
      command,
      args,
      ok: true,
      exitCode: result.exitCode ?? 0,
      signal: result.signal ?? null,
      timedOut: result.timedOut ?? false,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (error) {
    const context = error?.result ?? error?.context ?? {};
    return {
      command: context.command ?? command,
      args: context.args ?? args,
      ok: false,
      exitCode: context.exitCode ?? error?.exitCode ?? null,
      signal: context.signal ?? error?.signal ?? null,
      timedOut: context.timedOut ?? false,
      stdout: error?.stdout ?? context.stdout ?? "",
      stderr:
        error?.stderr ??
        context.stderr ??
        (error instanceof Error ? error.message : String(error ?? ""))
    };
  }
}

function appendCommandBlock(lines, label, capture) {
  lines.push(
    "",
    `${label}`,
    "```text",
    [
      `$ ${formatCommand(capture.command, capture.args)}`,
      `ok: ${capture.ok}`,
      `exitCode: ${capture.exitCode ?? "null"}`,
      capture.signal ? `signal: ${capture.signal}` : "",
      capture.timedOut ? "timedOut: true" : "",
      "",
      "stdout:",
      renderTextBody(capture.stdout),
      "",
      "stderr:",
      renderTextBody(capture.stderr)
    ]
      .filter(Boolean)
      .join("\n"),
    "```"
  );
}

function appendFileBlock(lines, label, filePath) {
  lines.push("", `${label}`, "```text", readTextPreview(filePath), "```");
}

function appendDirectoryBlock(lines, label, directoryPath) {
  const files = listFiles(directoryPath);

  lines.push(
    "",
    `${label}`,
    "```text",
    files.length > 0
      ? files
          .map((filePath) => path.relative(directoryPath, filePath))
          .join("\n")
      : `(missing or empty: ${directoryPath})`,
    "```"
  );

  for (const filePath of files) {
    lines.push(
      "",
      `log tail: ${filePath}`,
      "```text",
      readTextPreview(filePath),
      "```"
    );
  }
}

function listFiles(directoryPath, maxFiles = 6) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const files = [];
  const queue = [directoryPath];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(resolved);
        continue;
      }

      if (entry.isFile()) {
        files.push(resolved);
      }

      if (files.length >= maxFiles) {
        break;
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function readTextPreview(filePath, maxLength = 4_000) {
  if (!fs.existsSync(filePath)) {
    return `(missing: ${filePath})`;
  }

  const content = fs.readFileSync(filePath, "utf8");
  if (content.length <= maxLength) {
    return content.trimEnd() || "(empty)";
  }

  return `...(truncated to last ${maxLength} chars)\n${content.slice(-maxLength).trimStart()}`;
}

function renderTextBody(value) {
  const trimmed = String(value ?? "").trimEnd();
  return trimmed.length > 0 ? trimmed : "(empty)";
}

function formatCommand(command, args) {
  return [command, ...(args ?? [])]
    .map((entry) => JSON.stringify(entry))
    .join(" ");
}

function normalizeInlineText(value) {
  return String(value ?? "unknown failure")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractPrefixedLine(output, prefix) {
  const line = String(output ?? "")
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function getManagedPm2Entrypoint(runtimeRoot) {
  return process.platform === "win32"
    ? path.join(
        runtimeRoot,
        "program",
        "npm",
        "node_modules",
        "pm2",
        "bin",
        "pm2"
      )
    : path.join(
        runtimeRoot,
        "program",
        "npm",
        "lib",
        "node_modules",
        "pm2",
        "bin",
        "pm2"
      );
}

function getWrapperSmokeCommand(wrapperPath) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `"${wrapperPath}" --help`]
    };
  }

  return {
    command: wrapperPath,
    args: ["--help"]
  };
}
