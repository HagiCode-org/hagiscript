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
```

The split is intentional:

- `program/` holds managed executables, vendored payloads, wrappers, and the managed npm prefix.
- `runtime-data/` holds mutable config, logs, state, PM2 data, and component-specific writable files.

The packaged manifest currently manages:

- `node` - managed Node.js runtime
- `dotnet` - managed .NET and ASP.NET Core runtime
- `npm-packages` - managed npm prefix, including `pm2`
- `server` - released backend package metadata and PM2 launch assets for `lib/PCode.Web.dll`
- `omniroute` - vendored bundled runtime
- `code-server` - vendored bundled runtime

## Core Runtime Commands

Install the full runtime:

```bash
hagiscript runtime install
```

Install selected components only:

```bash
hagiscript runtime install --components node,npm-packages
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

Examples:

```bash
hagiscript pm2 server start
hagiscript pm2 server restart
hagiscript pm2 server status
hagiscript pm2 omniroute status
hagiscript pm2 omniroute start
hagiscript pm2 code-server stop
```

The PM2 flow is runtime-scoped:

- PM2 is installed into the managed npm prefix, not the host environment.
- Hagiscript resolves the runtime manifest before every PM2 action.
- PM2 runs with the managed Node runtime and managed PATH ordering.
- `PM2_HOME` is derived from the managed runtime layout, so service state stays inside the runtime data boundary.

This means maintenance scripts should call `hagiscript pm2 ...` instead of a system `pm2` binary.

### Released backend `server` contract

The packaged runtime manifest treats `server` as a `released-service` component. The managed runtime expects a published backend package staged under:

```text
<runtime-root>/program/components/server/current/
  lib/PCode.Web.dll
  lib/PCode.Web.deps.json
  lib/PCode.Web.runtimeconfig.json
  start.sh (or the platform equivalent from the release package)
```

Hagiscript keeps mutable launch state for that service under:

```text
<runtime-root>/runtime-data/components/services/server/
  .pm2/
  pm2-runtime/
```

`hagiscript runtime install --components server` prepares the runtime-owned launch assets and reports whether the published payload is already staged. `hagiscript pm2 server start` then generates the final PM2 ecosystem/env files under `pm2-runtime/` and launches the released backend through the managed `dotnet` runtime.

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

Validate an existing managed Node.js runtime:

```bash
hagiscript check-node --target /opt/hagiscript/node
```

### Managed npm Package Sync

Sync npm global packages into a managed runtime instead of the host environment:

```bash
hagiscript npm-sync --manifest ./manifest.json
hagiscript npm-sync --runtime /opt/hagiscript/node --manifest ./manifest.json
```

This is mainly useful when runtime maintenance also needs a controlled agent CLI or package inventory inside the managed runtime.

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
npm run integration:installed-runtime
```

The runtime-management integration path also supports a release-oriented validation mode for CI:

```bash
HAGISCRIPT_ENABLE_RELEASED_SERVER_TEST=1 npm run integration:runtime-management
```

That mode downloads the latest public backend package from `https://github.com/HagiCode-org/releases/releases`, stages it into the managed runtime, and verifies `server` start/restart/stop/remove through HagiScript-managed PM2.

## License

MIT. See [LICENSE](./LICENSE).
