import { createServer } from "node:http"
import { mkdtemp, readFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { gzipSync } from "node:zlib"
import { execa } from "execa"

const repoRoot = process.cwd();
const installCodeServerScript = path.join(repoRoot, "runtime", "scripts", "install-code-server.mjs");
const releaseVersion = "2026.0516.0063";
const releaseTag = "v" + releaseVersion;

async function run() {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "reproduce-hagiscript-"));
  console.log("Runtime root:", runtimeRoot);
  const outputPath = path.join(runtimeRoot, "code-server-output.json");
  const vendoredPlatform = getVendoredPlatform();
  const vendoredArch = getVendoredArch();
  const assetName = `code-server-${releaseVersion}-${vendoredPlatform}-${vendoredArch}.tar.gz`;

  const assetBuffer = createTarGzArchive("release", {
    "out/node/entry.js": createRecordedEntrypoint({
      includeEnvKeys: [],
      moduleType: "cjs"
    })
  });

  const releaseServer = await startVendoredReleaseServer([{ name: assetName, contents: assetBuffer }]);
  console.log("Release server base URL:", releaseServer.baseUrl);

  try {
    const env = createRuntimeScriptEnv(runtimeRoot, "code-server", releaseServer.baseUrl);
    console.log("Installing code-server...");
    await execa(process.execPath, [installCodeServerScript], {
      cwd: repoRoot,
      env
    });

    const commandWrapperPath = path.join(
      runtimeRoot,
      "program",
      "bin",
      process.platform === "win32" ? "code-server.cmd" : "code-server"
    );

    console.log("Running wrapper:", commandWrapperPath);
    const launcherResult = await execa(commandWrapperPath, ["--version"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TEST_OUTPUT_PATH: outputPath
      },
      reject: false
    });

    console.log("Launcher exit code:", launcherResult.exitCode);
    console.log("Launcher stdout:", launcherResult.stdout);
    console.log("Launcher stderr:", launcherResult.stderr);

    try {
      const launched = await readFile(outputPath, "utf8");
      console.log("Output JSON content:", launched);
    } catch (error: unknown) {
      console.log(
        "Failed to read output JSON:",
        error instanceof Error ? error.message : String(error)
      );
    }
  } finally {
    await releaseServer.close();
    // await rm(runtimeRoot, { recursive: true, force: true });
  }
}

// Helpers copied from test
function createRuntimeScriptEnv(runtimeRoot: string, componentName: string, baseUrl: string) {
  const runtimeHome = path.join(runtimeRoot, "program");
  const runtimeDataRoot = path.join(runtimeRoot, "runtime-data");
  const componentDataHome = path.join(runtimeDataRoot, "components", "services", componentName);
  return {
    ...process.env,
    HAGISCRIPT_RUNTIME_ROOT: runtimeRoot,
    HAGICODE_RUNTIME_HOME: runtimeHome,
    HAGICODE_RUNTIME_DATA_HOME: componentDataHome,
    HAGISCRIPT_RUNTIME_BIN_DIR: path.join(runtimeHome, "bin"),
    HAGISCRIPT_RUNTIME_CONFIG_DIR: path.join(runtimeDataRoot, "config"),
    HAGISCRIPT_RUNTIME_LOGS_DIR: path.join(runtimeDataRoot, "logs"),
    HAGISCRIPT_RUNTIME_DATA_DIR: path.join(runtimeDataRoot, "data"),
    HAGICODE_VENDORED_RELEASE_BASE_URL: baseUrl,
  };
}

async function startVendoredReleaseServer(assets: Array<{ name: string; contents: Buffer }>) {
  const assetsByName = new Map(assets.map((asset) => [asset.name, asset.contents]));
  const server = createServer((request, response) => {
    const url = request.url || "";
    const prefix = `/HagiCode-org/vendered/releases/download/${encodeURIComponent(releaseTag)}/`;
    if (url.startsWith(prefix)) {
      const assetName = decodeURIComponent(url.slice(prefix.length));
      const assetBuffer = assetsByName.get(assetName);
      if (assetBuffer) {
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader("Content-Length", String(assetBuffer.length));
        response.end(assetBuffer);
        return;
      }
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected release test server to expose a TCP address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function createTarGzArchive(rootDirectory: string, files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([relativePath, content]) =>
    createTarFileEntry(`${rootDirectory}/${relativePath}`, Buffer.from(content, "utf8"))
  );
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function createTarFileEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, name, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, content.length, 124, 12);
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarChecksum(header);
  const paddingLength = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(paddingLength)]);
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number) {
  Buffer.from(value).copy(buffer, offset, 0, Math.min(length, Buffer.byteLength(value)));
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number) {
  const octal = value.toString(8).padStart(length - 1, "0");
  buffer.write(octal, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function writeTarChecksum(buffer: Buffer) {
  let checksum = 0;
  for (const byte of buffer.values()) checksum += byte;
  const rendered = checksum.toString(8).padStart(6, "0");
  buffer.write(rendered, 148, 6, "ascii");
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function createRecordedEntrypoint(options: { includeEnvKeys: string[]; moduleType: "cjs" | "esm" }) {
  const envEntries = options.includeEnvKeys.map((key) => `    ${JSON.stringify(key)}: process.env[${JSON.stringify(key)}] ?? null`).join(",\n");
  const fileSystemImport = options.moduleType === "esm" ? 'import { writeFile } from "node:fs/promises"' : 'const { writeFile } = require("node:fs/promises")';
  return `#!/usr/bin/env node
${fileSystemImport}
async function main() {
  console.log("Entrypoint starting...");
  console.log("TEST_OUTPUT_PATH:", process.env.TEST_OUTPUT_PATH);
  if (!process.env.TEST_OUTPUT_PATH) {
    console.error("TEST_OUTPUT_PATH is NOT set in entrypoint!");
    process.exit(1);
  }
  await writeFile(
    process.env.TEST_OUTPUT_PATH,
    JSON.stringify({
      argv: process.argv.slice(2),
      env: {
${envEntries || "      "}
      }
    })
  );
  console.log("Entrypoint finished writing to", process.env.TEST_OUTPUT_PATH);
}
main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + "\\n");
  process.exit(1);
});
`;
}

function getVendoredPlatform() { return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"; }
function getVendoredArch() { if (process.arch === "x64") return "amd64"; if (process.arch === "arm64") return "arm64"; throw new Error("Unsupported"); }

run().catch(console.error);
