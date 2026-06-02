# Hagiscript Runtime Guide

[![npm version](https://img.shields.io/npm/v/%40hagicode%2Fhagiscript?logo=npm&color=cb3837)](https://www.npmjs.com/package/@hagicode/hagiscript)
[![npm downloads](https://img.shields.io/npm/dm/%40hagicode%2Fhagiscript?logo=npm&color=2d8cf0)](https://www.npmjs.com/package/@hagicode/hagiscript)
[![license](https://img.shields.io/badge/license-MIT-ffd43b)](./LICENSE)

`@hagicode/hagiscript` is the CLI used to install and operate a managed HagiCode runtime. It manages the runtime layout, bundled services, managed npm tools, and the released backend server from a manifest-driven workflow.

## Install The CLI

```bash
npm install -g @hagicode/hagiscript
```

Check the installed version:

```bash
hagiscript --version
```

## Quick Start

For a first-time setup, run these commands in order:

```bash
npm install -g @hagicode/hagiscript
hagiscript runtime install
hagiscript server install
hagiscript server start
hagiscript server status
```

If you also want the npm tools declared in your runtime manifest:

```bash
hagiscript npm-sync --runtime-root ~/.hagicode/runtime
```

If you are working with a custom manifest or runtime root, use the same flow with explicit paths:

```bash
hagiscript runtime install \
	--from-manifest ./runtime/manifest.yaml \
	--runtime-root ~/.hagicode/runtime

hagiscript server install \
	--from-manifest ./runtime/manifest.yaml \
	--runtime-root ~/.hagicode/runtime

hagiscript server start \
	--from-manifest ./runtime/manifest.yaml \
	--runtime-root ~/.hagicode/runtime
```

## What Hagiscript Manages

The packaged runtime manifest defines these managed components:

- `node`: managed Node.js runtime
- `dotnet`: managed .NET runtime
- `omniroute`: bundled PM2-managed service, optional by default
- `code-server`: bundled PM2-managed service
- `server`: released backend service package

By default, `hagiscript runtime install` prepares the required runtime set and does not install `omniroute` unless you explicitly include it with `--components`.

The managed runtime layout separates immutable program files from mutable data:

- `program/`: installed runtime payloads, wrappers, bundled executables
- `runtime-data/`: mutable config, logs, PM2 state, managed npm packages
- `server/`: installed released server versions
- `server-data/`: server config, logs, PM2 runtime files, version state

By default, the packaged manifest installs into `~/.hagicode/runtime`, but you can override that with `--runtime-root`.

## Runtime Basics

Create a standalone editable manifest from Hagiscript's packaged default:

```bash
hagiscript manifest init ./hagiscript.manifest.yaml
```

Generate a manifest and set the managed layout at the same time:

```bash
hagiscript manifest init ./hagiscript.manifest.yaml \
	--runtime-home program \
	--runtime-data-root runtime-data \
	--server-program-root server \
	--server-data-root server-data
```

Update an existing manifest after initialization:

```bash
hagiscript manifest set ./hagiscript.manifest.yaml \
	--npm-package-version pm2=7.0.2 \
	--npm-package-version @openai/codex=0.126.0 \
	--server-active-version 0.1.0-beta.60
```

Print the current manifest summary in a friendlier format:

```bash
hagiscript manifest get ./hagiscript.manifest.yaml
```

Install the default runtime:

```bash
hagiscript runtime install
```

Install from an explicit manifest into a specific root:

```bash
hagiscript runtime install \
	--from-manifest ./runtime/manifest.yaml \
	--runtime-root ~/.hagicode/runtime
```

Show the current runtime state:

```bash
hagiscript runtime state
```

Show machine-readable state:

```bash
hagiscript runtime state --json
```

Preview what would be installed without changing files:

```bash
hagiscript runtime install --dry-run
```

Update installed components:

```bash
hagiscript runtime update
```

Only check whether updates are needed:

```bash
hagiscript runtime update --check-only
```

Remove the runtime but keep retained data where supported:

```bash
hagiscript runtime remove
```

Purge runtime data as well:

```bash
hagiscript runtime remove --purge
```

Operate on selected components only:

```bash
hagiscript runtime install --components node,dotnet
hagiscript runtime update --components code-server,omniroute
hagiscript runtime remove --components code-server --purge
hagiscript runtime install --components omniroute
```

## Runtime Install Workflow

The typical runtime flow is:

```bash
hagiscript runtime install
hagiscript runtime state
hagiscript runtime update
```

If you want a clean rebuild:

```bash
hagiscript runtime remove --purge
hagiscript runtime install
```

## Server Install And Management

The managed server is installed separately from the core runtime. `hagiscript server install` ensures runtime dependencies are available, resolves a released server package, and makes that version active.

Install the server from the default source:

```bash
hagiscript server install
```

Install the server against an explicit runtime manifest and root:

```bash
hagiscript server install \
	--from-manifest ./runtime/manifest.yaml \
	--runtime-root ~/.hagicode/runtime
```

Install from a local archive:

```bash
hagiscript server install --archive ./hagicode-server.zip
```

Install from a specific index version:

```bash
hagiscript server install --index-version 0.1.0-beta.60
```

List installed server versions and the active version:

```bash
hagiscript server list
```

Switch the active version:

```bash
hagiscript server use 0.1.0-beta.60
```

Remove an installed version:

```bash
hagiscript server remove 0.1.0-beta.60
```

## Server Lifecycle

Start the managed server:

```bash
hagiscript server start
```

Stop it:

```bash
hagiscript server stop
```

Restart it:

```bash
hagiscript server restart
```

Check status:

```bash
hagiscript server status
```

Show the startup environment:

```bash
hagiscript server env
```

Emit JSON for status or environment:

```bash
hagiscript server status --json
hagiscript server env --json
```

Override the PM2 instance name used for namespaced app names:

```bash
hagiscript server start --instance myruntime
```

## Server Configuration

Read the effective managed server config:

```bash
hagiscript server config get
```

Update host and port:

```bash
hagiscript server config set --host 127.0.0.1 --port 39150
```

Read the config as JSON:

```bash
hagiscript server config get --json
```

## Dedicated OmniRoute And code_server Commands

Hagiscript also exposes first-level commands for the two bundled desktop-facing services:

```bash
hagiscript omniroute exact|start|stop|restart|status|env|logs
hagiscript code_server exact|start|stop|restart|status|env|logs
```

These commands are compatibility wrappers over the same managed PM2 contract used by `hagiscript pm2 omniroute ...` and `hagiscript pm2 code-server ...`. They keep the same runtime-scoped PM2 home and managed service identity while hiding the lower-level extracted-runtime details from desktop callers and automation.

The primary bundled-runtime flow is 7z-only:

```bash
hagiscript runtime install
hagiscript omniroute exact
hagiscript omniroute start
hagiscript omniroute status --json

hagiscript code_server exact
hagiscript code_server start
hagiscript code_server logs --lines 50
```

`exact` resolves the packaged component `.7z` artifact, extracts it into `runtime-data/runtimeComponents/<component>/<version>/current`, validates the extracted layout, and records the extracted runtime metadata under the component runtime-data home. Later lifecycle and log commands operate on that extracted managed runtime rather than on the packaged archive directory.

Examples with explicit runtime context:

```bash
hagiscript omniroute exact \
	--from-manifest ./runtime/manifest.yaml \
	--runtime-root ~/.hagicode/runtime

hagiscript code_server env \
	--from-manifest ./runtime/manifest.yaml \
	--runtime-root ~/.hagicode/runtime \
	--json
```

Read recent allowlisted managed logs:

```bash
hagiscript omniroute logs --lines 100
hagiscript code_server logs --lines 50 --json
```

The dedicated `logs` action only reads allowlisted managed log targets beneath each component runtime-data boundary. Missing log files return a successful empty result instead of crashing.

`.7z` extraction uses Hagiscript's bundled cross-platform extractor and does not require users or desktop callers to install a system `7z` binary.

## Managed NPM Tool Sync

The runtime manifest can also declare managed npm packages under `npmSync`. These packages are installed into the resolved runtime data prefix under `runtime-data/npm` for relative manifests, or under `~/.hagicode/runtime-data/npm` for the default managed layout, not into `program/`.

If the managed runtime has already been installed, `npm-sync` can read the canonical `state.json` from the resolved runtime data root and automatically reuse the recorded `manifestPath` and managed npm prefix. In that case you do not need to pass `--from-manifest`.

Sync npm packages by pointing at the runtime root:

```bash
hagiscript npm-sync --runtime-root ~/.hagicode/runtime
```

Sync npm packages declared in a runtime manifest:

```bash
hagiscript npm-sync --from-manifest ./runtime/manifest.yaml
```

`npm-sync` does not define its own program/data/server root layout. It reads the runtime manifest associated with the selected runtime root and follows that manifest's `npmSync` definition.

If you want to change the npm tool versions captured in a manifest, update the manifest first:

```bash
hagiscript manifest set ./hagiscript.manifest.yaml \
	--npm-package-version pm2=7.0.2 \
	--npm-package-version @openai/codex=0.126.0
```

Use an explicit managed Node runtime and prefix:

```bash
hagiscript npm-sync \
	--from-manifest ./runtime/manifest.yaml \
	--managed-runtime ~/.hagicode/runtime/program/components/node/runtime \
	--prefix ~/.hagicode/runtime/runtime-data/npm
```

Force re-sync even if installed versions already satisfy the requested target:

```bash
hagiscript npm-sync --from-manifest ./runtime/manifest.yaml --force
```

## Common End-To-End Flow

For a fresh machine or a new runtime root, this is the usual sequence:

```bash
hagiscript runtime install
hagiscript server install
hagiscript server start
hagiscript server status
```

If you also want the manifest-declared npm tools:

```bash
hagiscript npm-sync --runtime-root ~/.hagicode/runtime
```

## Useful Flags

- `manifest init [path]`: generate an editable manifest from the packaged default
- `manifest get [path]`: print a readable summary of the current manifest
- `manifest set <path>`: update manifest paths, npmSync package versions, or server defaults
- `--from-manifest <path>`: use a specific runtime manifest YAML
- `--runtime-root <path>`: change the managed runtime root
- `--runtime-home <path>`: set the manifest's program root
- `--runtime-data-root <path>`: set the manifest's runtime-data root
- `--server-program-root <path>`: set the manifest's server program root
- `--server-data-root <path>`: set the manifest's server data root
- `--npm-package-version <package=version>`: update a manifest npmSync package entry
- `--server-active-version <version>`: set the manifest's preferred managed server version
- `--components <list>`: target specific runtime components
- `--dry-run`: print the plan without mutating files
- `--force`: force reinstall or update where supported
- `--purge`: remove retained mutable data during runtime removal
- `--json`: emit machine-readable output for `manifest get`, state, status, env, and config commands
- `--lines <count>`: limit recent log output for `hagiscript omniroute logs` and `hagiscript code_server logs`

For downstream automation, `--json` is supported by the dedicated `omniroute` and `code_server` actions as well. Dedicated JSON envelopes always include `component`, `service`, `action`, and `ok`, then add action-specific payloads for extraction paths, lifecycle status, resolved environment, or returned log lines.

## License

MIT. See [LICENSE](./LICENSE).
