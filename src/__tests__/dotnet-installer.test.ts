import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDotnetInstallScriptUrl,
  installManagedDotnetRuntime,
  mapDotnetArchitecture,
  parseInstalledDotnetRuntimes
} from "../runtime/dotnet-installer.js";

const tempRoots: string[] = [];
const runPosixOnly = process.platform === "win32" ? it.skip : it;

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("managed .NET runtime installer", () => {
  it("parses dotnet runtime inventory output", () => {
    expect(
      parseInstalledDotnetRuntimes(`Microsoft.NETCore.App 10.0.5 [/tmp/dotnet/shared/Microsoft.NETCore.App]
Microsoft.AspNetCore.App 10.0.5 [/tmp/dotnet/shared/Microsoft.AspNetCore.App]
`)
    ).toEqual({
      "Microsoft.NETCore.App": ["10.0.5"],
      "Microsoft.AspNetCore.App": ["10.0.5"]
    });
  });

  it("maps supported architectures and builds installer URLs", () => {
    expect(mapDotnetArchitecture("x64")).toBe("x64");
    expect(mapDotnetArchitecture("aarch64")).toBe("arm64");
    expect(buildDotnetInstallScriptUrl("linux", "https://example.test/base/")).toBe(
      "https://example.test/base/dotnet-install.sh"
    );
    expect(buildDotnetInstallScriptUrl("win32", "https://example.test/base")).toBe(
      "https://example.test/base/dotnet-install.ps1"
    );
  });

  runPosixOnly(
    "downloads the installer script and installs both .NET runtime packs",
    async () => {
      const root = await makeTempRoot();
      const targetDirectory = join(root, "managed-dotnet");
      const version = "10.0.5";
      const fakeInstaller = createFakeDotnetInstallerScript();
      const server = await startScriptServer(fakeInstaller);

      try {
        const result = await installManagedDotnetRuntime({
          targetDirectory,
          version,
          scriptBaseUrl: server.baseUrl,
          timeoutMs: 60_000
        });

        expect(result.valid).toBe(true);
        expect(result.targetDirectory).toBe(targetDirectory);
        expect(result.installedRuntimes["Microsoft.NETCore.App"]).toContain(version);
        expect(result.installedRuntimes["Microsoft.AspNetCore.App"]).toContain(version);
        expect(await readFile(join(targetDirectory, "dotnet"), "utf8")).toContain(
          "--list-runtimes"
        );
      } finally {
        await server.close();
      }
    }
  );
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hagiscript-dotnet-installer-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function createFakeDotnetInstallerScript(): string {
  return `#!/usr/bin/env sh
set -eu

install_dir=""
version=""
runtime=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      install_dir="$2"
      shift 2
      ;;
    --version)
      version="$2"
      shift 2
      ;;
    --runtime)
      runtime="$2"
      shift 2
      ;;
    --architecture|--os|--channel)
      shift 2
      ;;
    --no-path|--verbose)
      shift 1
      ;;
    *)
      shift 1
      ;;
  esac
done

mkdir -p "$install_dir"

if [ "$runtime" = "dotnet" ]; then
  mkdir -p "$install_dir/shared/Microsoft.NETCore.App/$version"
  cat > "$install_dir/dotnet" <<'EOF'
#!/usr/bin/env sh
set -eu
script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

if [ "$#" -gt 0 ] && [ "$1" = "--info" ]; then
  printf '.NET SDK (fake)\\n'
  exit 0
fi

if [ "$#" -gt 0 ] && [ "$1" = "--list-runtimes" ]; then
  if [ -d "$script_dir/shared/Microsoft.NETCore.App/10.0.5" ]; then
    printf 'Microsoft.NETCore.App 10.0.5 [%s/shared/Microsoft.NETCore.App]\\n' "$script_dir"
  fi
  if [ -d "$script_dir/shared/Microsoft.AspNetCore.App/10.0.5" ]; then
    printf 'Microsoft.AspNetCore.App 10.0.5 [%s/shared/Microsoft.AspNetCore.App]\\n' "$script_dir"
  fi
  exit 0
fi

printf 'fake dotnet command\\n'
EOF
  chmod +x "$install_dir/dotnet"
elif [ "$runtime" = "aspnetcore" ]; then
  mkdir -p "$install_dir/shared/Microsoft.AspNetCore.App/$version"
fi
`;
}

async function startScriptServer(scriptContents: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url === "/dotnet-install.sh") {
      response.setHeader("Content-Type", "text/x-shellscript");
      response.end(scriptContents);
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected test server to expose a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
