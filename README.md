# Hagiscript

`@hagicode/hagiscript` is the scoped npm package foundation for future Hagiscript language tooling. This initial package intentionally keeps runtime behavior small: it exposes version metadata, a baseline runtime-info API, and an executable CLI placeholder that can be built, tested, packed, and published safely.

## Installation Assumptions

- Node.js 20 or newer is required.
- npm is the package manager for this standalone repository.
- The npm package name is `@hagicode/hagiscript`.
- GitHub Actions publishing uses `npm publish --provenance`. Local manual publishing should use plain `npm publish` unless you are inside a supported trusted publishing environment.

## Usage

Install the package from npm:

```bash
npm install @hagicode/hagiscript
```

The installed CLI command remains `hagiscript`.

Run the CLI locally during development:

```bash
npm run dev -- --help
npm run dev -- info
npm run dev -- install-node --target .tmp/node-runtime
npm run dev -- check-node --target .tmp/node-runtime
npm run dev -- npm-sync --runtime .tmp/node-runtime --manifest manifest.json
```

After building, run the compiled CLI:

```bash
npm run build
node dist/cli.js --version
node dist/cli.js info
node dist/cli.js install-node --target .tmp/node-runtime
node dist/cli.js check-node --target .tmp/node-runtime
node dist/cli.js npm-sync --runtime .tmp/node-runtime --manifest manifest.json
```

### Managed Node.js Runtime Commands

`install-node` downloads an official Node.js archive from `https://nodejs.org/dist`, extracts it into the target directory, and verifies both `node` and `npm` before reporting success.

```bash
hagiscript install-node --target /opt/hagiscript/node
hagiscript install-node --target /opt/hagiscript/node20 --version 20
hagiscript install-node --target /opt/hagiscript/lts --version lts
```

When `--version` is omitted, Hagiscript installs the latest available Node.js 22 release. Supported selectors are `lts`, `latest`, `current`, a major version such as `22`, an exact version such as `22.12.0`, or an exact version with a `v` prefix such as `v22.12.0`.

The target path must be missing or empty. Hagiscript refuses to install into a non-empty target directory and does not delete existing user files. During installation, temporary staging files are created beside the target directory and cleaned up after success or failure.

Example success output:

```text
Installing Node.js 22 into /opt/hagiscript/node
Download progress: 100%
Node.js runtime installed successfully.
Target: /opt/hagiscript/node
Node.js: v22.12.0
npm: 10.9.0
node: /opt/hagiscript/node/bin/node
npm: /opt/hagiscript/node/bin/npm
```

`check-node` validates an existing runtime directory and exits with code `0` only when both `node --version` and `npm --version` succeed.

```bash
hagiscript check-node --target /opt/hagiscript/node
```

Example valid output:

```text
Node.js runtime is valid.
Target: /opt/hagiscript/node
Node.js: v22.12.0
npm: 10.9.0
node: /opt/hagiscript/node/bin/node
npm: /opt/hagiscript/node/bin/npm
```

Example invalid output exits non-zero and includes the failure reason:

```text
Node.js runtime is invalid.
Target: /opt/hagiscript/node
Reason: missing executable
```

### npm Global Package Synchronization

`npm-sync` aligns npm global packages inside a HagiScript-managed Node.js runtime with a JSON manifest. By default, it verifies or installs the managed runtime at `~/.hagiscript/node-runtime` and uses that runtime's `npm`; it does not use or mutate npm from the ambient shell `PATH`. Existing automation can keep passing `--runtime` to use an explicit runtime directory.

```bash
hagiscript npm-sync --manifest ./manifest.json
hagiscript npm-sync --runtime /opt/hagiscript/node --manifest ./manifest.json
hagiscript npm-sync --manifest ./manifest.json --registry-mirror https://registry.npmmirror.com/
hagiscript npm-sync --manifest ./manifest.json --registry-mirror https://registry.npmmirror.com/ --mirror-only
```

Compatibility manifest schema:

```json
{
  "registryMirror": "https://registry.npmmirror.com/",
  "packages": {
    "<npm-package-name>": {
      "version": "<semver range>",
      "target": "<optional npm install selector>"
    }
  }
}
```

The required `version` field accepts package.json-style semver ranges such as `^1.2.0`, `>=1.0.0 <2.0.0`, or `1.0.0 || 2.0.0`. The optional `target` field controls the selector used for `npm install -g`; when omitted, Hagiscript installs `<package>@<version>`.

The optional top-level `registryMirror` field configures the npm registry used for both inventory and install commands. It must be a non-empty absolute `http:` or `https:` URL. When present, HagiScript first appends `--registry <registryMirror>` to `npm list -g --depth=0 --json` and `npm install -g <package>@<selector>` without changing package selection. If that mirror-backed npm command fails, HagiScript automatically retries the same inventory or install command once against the official npm registry `https://registry.npmjs.org/`. This mirror-first retry scope is intentionally limited to npm inventory and package mutation commands; runtime validation, manifest validation, and package planning do not retry. This is useful for public mirrors such as `https://registry.npmmirror.com/` or enterprise registries such as `https://npm.company.example/repository/npm/`.

Product-managed tool sync can use the expanded `tools` manifest shape. Mandatory tools are always included using internally pinned versions from `src/runtime/tool-sync-catalog.config.json`: OpenSpec skills (`skills@1.5.1`), OmniRoute (`omniroute@3.6.9`), and code-server (`code-server@4.117.0`). Optional agent CLI sync is enabled explicitly; selected built-in CLIs or custom npm packages are added when provided.

```json
{
  "registryMirror": "https://npm.company.example/repository/npm/",
  "tools": {
    "optionalAgentCliSyncEnabled": true,
    "selectedOptionalAgentCliIds": ["codex", "claude-code", "fission-openspec", "opencode"],
    "customAgentClis": [
      {
        "packageName": "@scope/agent-cli",
        "version": "^1.0.0"
      }
    ]
  }
}
```

The first built-in optional agent CLI IDs are `codex` (`@openai/codex@0.125.0`), `claude-code` (`@anthropic-ai/claude-code@2.1.119`), `fission-openspec` (`@fission-ai/openspec@1.3.1`), `qoder` (`@qoder-ai/qodercli@0.1.48`), and `opencode` (`opencode-ai@1.14.24`). These built-in package versions are pinned in `src/runtime/tool-sync-catalog.config.json`. HagiScript validates unknown tool IDs, npm package names, and version selectors before `npm list` or `npm install` runs.

Use `--registry-mirror <url>` when automation needs to override the manifest registry for a single run. Precedence is CLI override first, manifest `registryMirror` second, and npm's default registry behavior third. If neither the CLI nor manifest provides a mirror, HagiScript does not add `--registry` and existing npm defaults, `.npmrc`, or environment configuration continue to apply.

Use `--mirror-only` when a run must stay on the configured mirror and must not retry against `https://registry.npmjs.org/`. When omitted, automatic official-registry fallback remains enabled by default for mirror-backed npm inventory and install commands.

For simple product-managed requests, optional CLI selections can be provided directly without writing a manifest:

```bash
hagiscript npm-sync --selected-agent-cli codex
hagiscript npm-sync --selected-agent-cli codex --custom-agent-cli @scope/agent-cli@^1.0.0
```

Example manifest for openspec and skills tooling:

```json
{
  "packages": {
    "@openspec/cli": {
      "version": "^1.0.0"
    },
    "@hagicode/skills": {
      "version": ">=0.5.0 <1.0.0",
      "target": "0.5.4"
    }
  }
}
```

During execution, Hagiscript validates the manifest and runtime before any npm install command runs, lists global packages with `/opt/hagiscript/node/bin/npm list -g --depth=0 --json`, plans no-op, install, upgrade, downgrade, or sync actions, and then runs `npm install -g <package>@<selector>` only for packages that need changes.

Example output:

```text
Manifest validated: ./manifest.json (2 packages, mode=packages)
Registry mirror: https://registry.npmmirror.com/
Fallback policy: auto
Runtime validated: /opt/hagiscript/node
node: /opt/hagiscript/node/bin/node (v22.12.0)
npm: /opt/hagiscript/node/bin/npm (10.9.0)
Detected global packages: 4
Plan: @openspec/cli noop installed=1.0.2 required=^1.0.0 selector=@openspec/cli@^1.0.0
Skip: @openspec/cli already satisfies range
Plan: @hagicode/skills upgrade installed=0.4.0 required=>=0.5.0 <1.0.0 selector=@hagicode/skills@0.5.4
Install: @hagicode/skills using @hagicode/skills@0.5.4
Synced: @hagicode/skills (upgrade)
npm-sync complete.
Runtime: /opt/hagiscript/node
Manifest: ./manifest.json
Mode: packages
Registry mirror: https://registry.npmmirror.com/
Fallback policy: auto
Fallback used: no
Packages: 2
No-op: 1
Changed: 1
```

When fallback is triggered, HagiScript logs `Fallback used: ...` during execution and records `Fallback detail: ...` in the final summary so CI or desktop automation can see which mirror failed, which official registry retry was used, and whether that retry succeeded.

Use the library API from ESM consumers:

```ts
import { createRuntimeInfo, getPackageMetadata } from "@hagicode/hagiscript";

console.log(getPackageMetadata());
console.log(createRuntimeInfo());
```

## Development Commands

Run all commands from `repos/hagiscript/`:

```bash
npm install
npm run lint
npm run format:check
npm test
npm run build
npm run pack:check
```

Additional commands:

```bash
npm run clean
npm run format
npm run test:watch
npm run publish:prepare-dev-version
npm run publish:verify-release -- v0.1.0
```

## Build Outputs

`npm run build` compiles TypeScript with strict NodeNext settings into `dist/`. Expected entry points include:

- `dist/index.js`
- `dist/index.d.ts`
- `dist/index.js.map`
- `dist/cli.js`
- `dist/cli.d.ts`
- `dist/cli.js.map`

The package `exports` field points consumers to `dist/index.js` and `dist/index.d.ts`. The published package name is `@hagicode/hagiscript`, and the `bin.hagiscript` entry points to `dist/cli.js`.

## Package Verification

`npm run pack:check` runs a dry-run package inspection and fails if required runtime files are missing or source-only files are accidentally included. The published package should contain generated `dist` files and documentation, not raw tests, scripts, coverage, or temporary files.

## Release Automation

GitHub Actions provide three automation paths:

- `ci.yml` installs dependencies with `npm ci`, then runs lint, format check, tests, build, and package verification.
- `npm-publish.yml` resolves a unique prerelease version from `main`, stamps both `package.json` and `package-lock.json` with `npm version --no-git-tag-version`, then publishes to the `dev` dist-tag.
- `npm-publish.yml` also publishes stable GitHub releases tagged as `vX.Y.Z` to the `latest` dist-tag after validating the tag format, rejecting tags older than the repository base version, and stamping the stable version the same way.
- `release-drafter.yml` keeps a categorized release draft using `.github/release-drafter.yml`.

Before the first publish, make sure the npm organization or user scope `hagicode` exists on npm and grant publish access for `@hagicode/hagiscript`. For GitHub Actions releases, configure npm trusted publishing with package `@hagicode/hagiscript`, owner `HagiCode-org`, repository `hagiscript`, and workflow filename `npm-publish.yml`. Do not enter the full workflow path as the filename; leave the npm environment field empty unless the workflow job explicitly declares an environment. If the scope is missing or the workflow identity cannot create packages under it, npm returns `E404 Not Found` during the final `PUT https://registry.npmjs.org/@hagicode%2fhagiscript` publish request.

Run the publish prerequisite check before retrying a failed release:

```bash
npm run publish:check-prereqs
```

For local manual releases, run plain `npm publish` after logging in with an npm account that can publish under `@hagicode`.
