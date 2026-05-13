# Hagiscript Runtime Guide

[![npm version](https://img.shields.io/npm/v/%40hagicode%2Fhagiscript?logo=npm&color=cb3837)](https://www.npmjs.com/package/@hagicode/hagiscript)
[![npm downloads](https://img.shields.io/npm/dm/%40hagicode%2Fhagiscript?logo=npm&color=2d8cf0)](https://www.npmjs.com/package/@hagicode/hagiscript)
[![license](https://img.shields.io/badge/license-MIT-ffd43b)](./LICENSE)

`@hagicode/hagiscript` is the runtime management CLI behind the `hagicode-runtime` contract. Use it to install, inspect, update, remove, and operate a managed HagiCode runtime without depending on system Node.js, system PM2, or host-global npm packages.

## Install

```bash
npm install -g @hagicode/hagiscript
```

Primary entrypoints:

- `hagiscript`
- `hagicode-runtime` (`hagiscript runtime ...` wrapper)

Node.js 20 or newer is required to run the package itself.

## Runtime Model

By default, Hagiscript loads `runtime/manifest.yaml` and manages the runtime under `~/.hagicode/runtime`.

```text
<runtime-root>/
  program/
    bin/
    npm/
    components/
  runtime-data/
    config/
    logs/
    data/
    components/
    state.json
  server/
    versions/
  server-data/
    .pm2/
    pm2-runtime/
    config/
    versions-state.json
```

The split is intentional:

- `program/` holds managed executables, vendored payloads, wrappers, and the managed npm prefix.
- `runtime-data/` holds mutable config, logs, state, and component-specific writable files.
- `server/` holds versioned backend payloads for the released `server` service.
- `server-data/` holds mutable PM2 state and shared launch assets for that `server` service.

The packaged manifest currently manages:

- `node` - managed Node.js runtime
- `dotnet` - managed .NET and ASP.NET Core runtime
- `server` - released backend package metadata and PM2 launch assets for `lib/PCode.Web.dll`
- `omniroute` - vendored bundled runtime
- `code-server` - vendored bundled runtime

The runtime layout still reserves `program/npm/` as the managed npm prefix, but package inventory inside that prefix is not part of the runtime component manifest. Tool installation there is handled separately through `hagiscript npm-sync` or external provisioning.

## Core Runtime Commands

Install the full runtime:

```bash
hagiscript runtime install
```

Runtime installs reuse a shared download cache by default. Disable it with `--no-download-cache`, or relocate it with `--download-cache-dir <path>`.

Install selected components only:

```bash
hagiscript runtime install --components node,omniroute
```

Preview planned changes without mutating files:

```bash
hagiscript runtime install --dry-run
hagiscript runtime update --check-only
```

Inspect the canonical runtime state:

```bash
hagiscript runtime state
hagiscript runtime state --json
```

Update or remove managed components:

```bash
hagiscript runtime update
hagiscript runtime remove --components code-server --purge
```

Override the runtime root or manifest when needed:

```bash
hagiscript runtime install --runtime-root /srv/hagicode/runtime
hagiscript runtime state --from-manifest /path/to/runtime-manifest.yaml --json
```

If you prefer the runtime-oriented wrapper:

```bash
hagicode-runtime install --runtime-root /srv/hagicode/runtime
```

## Runtime State and Maintenance

`hagiscript runtime state --json` is the canonical inspection surface for automation. It reports:

- resolved runtime root
- `program/` and `runtime-data/` locations
- per-component install status
- per-component runtime data homes
- derived PM2 homes for managed services
- program/data path separation

Use it before and after maintenance work to confirm the expected component set and writable paths.

Typical maintenance flow:

1. Check current state: `hagiscript runtime state --json`
2. Apply changes: `hagiscript runtime install`, `update`, or `remove`
3. Re-check state to confirm the final layout
4. Operate services through `hagiscript pm2 ...`

Lifecycle commands print the resolved manifest, managed root, changed component count, skipped entries, and log file path when a log is generated.

## Managed PM2 Services

Hagiscript manages runtime-scoped PM2 services for:

- `server`
- `omniroute`
- `code-server`

Supported actions:

- `start`
- `restart`
- `stop`
- `status`
- `env`

Examples:

```bash
hagiscript pm2 server start
hagiscript pm2 server restart
hagiscript pm2 server status
hagiscript pm2 server env
hagiscript pm2 server env --json
hagiscript pm2 omniroute status
hagiscript pm2 omniroute start
hagiscript pm2 code-server stop
```

The PM2 flow is runtime-scoped:

- PM2 is resolved from the managed npm prefix, not the host environment.
- Hagiscript resolves the runtime manifest before every PM2 action.
- PM2 runs with the managed Node runtime and managed PATH ordering.
- `PM2_HOME` is derived from the managed runtime layout, so service state stays inside the runtime data boundary.

This means maintenance scripts should call `hagiscript pm2 ...` instead of a system `pm2` binary, and should ensure `pm2` has been installed into the managed npm prefix beforehand.

### Released backend `server` contract

The packaged runtime manifest treats `server` as a `released-service` component. Hagiscript stages released backend payloads under a dedicated versioned server root:

```text
<runtime-root>/server/
  versions/
    1.2.3/
      lib/PCode.Web.dll
      lib/PCode.Web.deps.json
      lib/PCode.Web.runtimeconfig.json
      start.sh (or the platform equivalent from the release package)
```

Hagiscript keeps mutable launch state for that service in a single shared data home, regardless of how many server versions are installed:

```text
<runtime-root>/server-data/
  .pm2/
  pm2-runtime/
  config/
  versions-state.json
```

`hagiscript server install` stages a concrete backend version, updates the active-version inventory in `versions-state.json`, ensures the fixed runtime dependencies, and keeps PM2 launch files under the shared `server-data` home. `hagiscript pm2 server start` then resolves the active server version, generates the final PM2 ecosystem/env files under `pm2-runtime/`, and launches the released backend through the managed `dotnet` runtime. Use `hagiscript pm2 server env` to print the exact resolved working directory, PATH ordering, and environment variables that HagiScript will use for that startup flow.

For the Desktop -> Hagiscript -> PM2 environment handoff, including variable ownership and precedence, see [docs/desktop-hagiscript-env-contract.md](docs/desktop-hagiscript-env-contract.md).

## Managed Server Commands

Hagiscript can now stage a released backend package and prepare all startup prerequisites from a single command surface:

```bash
hagiscript server install
hagiscript server install --package-dir /srv/hagicode/packages
hagiscript server install --archive ./hagicode-1.2.3-linux-x64-nort.zip
hagiscript server install --url https://example.com/hagicode-1.2.3-linux-x64-nort.zip
hagiscript server install --index-url https://index.example.com/hagicode/index.json --index-channel stable
hagiscript server install --github-repo HagiCode-org/releases --tag v1.2.3
```

By default, `server install`:

- selects or downloads a server archive
- extracts and stages it into `server/versions/<version>/`
- installs the fixed runtime dependencies declared by the server contract
- ensures `pm2` exists in the managed npm prefix

Inspect and switch the installed server inventory with:

```bash
hagiscript server list
hagiscript server use 1.2.3
hagiscript server remove 1.2.2
```

`server list` shows the active version and every staged payload under `server/versions/`. `server use` switches the active payload that `hagiscript server start` and `hagiscript pm2 server ...` will resolve. `server remove` deletes an inactive installed version while leaving the shared `server-data` directory intact.

Source priority for `server install` is:

1. local archive (`--archive`)
2. local folder (`--package-dir`)
3. direct URL (`--url`)
4. HTTP index (`--index-url`, optional `--index-channel`, `--index-version`)
5. GitHub release fallback (`--github-repo`, `--tag`, `--asset`)

When no explicit source option is provided, Hagiscript first tries the default official HTTP index:

- `https://index.hagicode.com/server/index.json`

If that index cannot be resolved, Hagiscript automatically falls back to GitHub release discovery.

When index mode is used, Hagiscript reads index JSON, picks the best matching asset for current platform/arch, and then downloads from either a direct URL field or the first marked primary entry in `downloadSources` (falling back to the first source entry).

Once installed, use the higher-level lifecycle wrappers:

```bash
hagiscript server start
hagiscript server restart --instance demo
hagiscript server stop --instance demo
hagiscript server status --json
hagiscript server env --instance demo
```

`--instance <name>` maps to the PM2 name identifier and defaults to `hagicode`, so one host can run multiple managed runtime roots without colliding app names.

## Local Playground Workflow

This repository includes a tracked `playground/` folder with its own `.gitignore`, so runtime artifacts created during local validation do not enter git.

All playground scripts use:

- manifest: `./playground/manifest.yaml`
- runtime root: `./playground/runtime-root`

Run the local lifecycle test flow:

```bash
npm run playground:runtime:install
npm run playground:runtime:state
npm run playground:server:install
npm run playground:server:start
npm run playground:server:status
npm run playground:server:env
npm run playground:server:stop
npm run playground:runtime:remove
```

Available playground scripts:

- `playground:runtime:install`
- `playground:runtime:state`
- `playground:runtime:update`
- `playground:runtime:remove`
- `playground:server:install`
- `playground:server:start`
- `playground:server:status`
- `playground:server:stop`
- `playground:server:env`

## Runtime Environment Contract

Runtime lifecycle scripts and managed services receive a stable environment contract:

- `HAGICODE_RUNTIME_HOME` - runtime program home
- `HAGICODE_RUNTIME_DATA_HOME` - writable runtime data home for the current component
- `PM2_HOME` - PM2 state directory for the current managed service
- `PATH` - rebuilt so managed Node, managed npm, and managed wrappers come first

This contract is what keeps installs, updates, wrappers, and PM2-managed services aligned to the same runtime root.

## Manifest Customization

`runtime/manifest.yaml` controls the runtime shape. Common override points:

- `paths.runtimeRoot`
- `paths.runtimeHome`
- `paths.runtimeDataRoot`
- `paths.componentDataRoot`
- `paths.defaultPm2Home`
- component `runtimeDataDir`
- service `pm2.appName`
- service `pm2.cwd`
- service `pm2.script`
- service `pm2.args`
- service `pm2.env`
- service `pm2.pm2Home`

For deployment-specific behavior, keep the packaged manifest as the baseline and pass `--from-manifest` with an override manifest rather than mutating the installed package in place.

## Related Runtime Tooling

### Managed Node Runtime

Install a standalone managed Node.js runtime:

```bash
hagiscript install-node --target /opt/hagiscript/node
hagiscript install-node --target /opt/hagiscript/node22 --version 22
```

Standalone Node installs also reuse the shared download cache by default. Pass `--no-download-cache` to force a fresh download, or `--download-cache-dir <path>` to share a custom cache location across installs.

Validate an existing managed Node.js runtime:

```bash
hagiscript check-node --target /opt/hagiscript/node
```

### Managed npm Package Sync

Sync npm global packages into the managed npm prefix instead of the host environment:

```bash
hagiscript npm-sync --manifest ./manifest.json
hagiscript npm-sync --runtime /opt/hagiscript/node --manifest ./manifest.json
hagiscript npm-sync --managed-runtime ~/.hagicode/runtime/program/components/node/runtime --prefix ~/.hagicode/runtime/program/npm --manifest ./manifest.json
```

When `npm-sync` has to provision a managed Node runtime first, it uses the same shared download cache by default.

This is the path for installing `pm2` and any other scenario-specific global tools. The package list is data, not a built-in runtime component.

## Development

Run from `repos/hagiscript/`:

```bash
npm install
npm test
npm run build
npm run pack:check
```

Useful runtime-focused checks:

```bash
npm run integration:runtime-management
npm run integration:runtime-key-path
npm run integration:installed-runtime
```

The dedicated runtime key-path flow validates the critical production sequence with real network downloads: runtime install for fixed components, npm-sync for scenario-specific tools in the managed npm prefix, and PM2 lifecycle commands resolved from that managed prefix. Run the base flow with:

```bash
npm run integration:runtime-key-path
```

The release-oriented key-path mode additionally stages the latest public backend package from GitHub Releases and validates the same managed PM2 contract for `server`:

```bash
HAGISCRIPT_ENABLE_RELEASED_SERVER_TEST=1 npm run integration:runtime-key-path
```

The broader runtime-management integration path remains available for the existing end-to-end runtime assertions, including the corresponding released-server mode:

```bash
HAGISCRIPT_ENABLE_RELEASED_SERVER_TEST=1 npm run integration:runtime-management
```

## License

MIT. See [LICENSE](./LICENSE).
