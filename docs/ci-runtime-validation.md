# CI Runtime Management Validation

The `runtime-management` job in `.github/workflows/ci.yml` validates the HagiScript runtime-management command surface in a real GitHub Actions runner. The job uses `actions/setup-node` only to install dependencies and build HagiScript itself; the Node runtime under test is installed, checked, and used by an npm-installed HagiScript package.

## Command Syntax

The CI job runs `npm run integration:installed-runtime`. That script packs the current build with `npm pack`, installs the tarball into a temporary npm project, and invokes the installed package binary at `node_modules/.bin/hagiscript` with these command shapes:

```bash
hagiscript install-node --target "$TEMP/custom-node-runtime"
hagiscript check-node --target "$TEMP/custom-node-runtime"
hagiscript npm-sync --runtime "$TEMP/custom-node-runtime" --manifest "$TEMP/manifest.json"
```

This intentionally validates the package installation surface a user or downstream automation consumes, including the `bin.hagiscript` entry in `package.json`. It does not call `node dist/cli.js` directly for the behavior under test.

`npm-sync --runtime` is the compatibility path for CI fixtures that install a known runtime in `$RUNNER_TEMP`. Product-managed synchronization can omit `--runtime`; HagiScript then verifies or installs its default managed runtime and uses that runtime's npm executable. In both paths, package inventory and mutation must use the resolved runtime npm rather than ambient shell `PATH`.

There is no command-name mapping layer for this validation. The user-facing shorthand names `install-node`, `check-node`, and `npm-sync` are the actual CLI command names registered by HagiScript.

## Expected Failure Signals

- `install-node` fails the job when HagiScript cannot download, extract, or verify the managed Node.js runtime. Successful output must include `Node.js runtime installed successfully.`, `Node.js:`, and `npm:` diagnostics.
- `check-node` fails the job when the managed runtime does not expose executable `node` and `npm` commands. Successful output must include `Node.js runtime is valid.`, `node:`, and `npm:` diagnostics.
- `npm-sync` fails the job when HagiScript cannot validate the manifest, validate or install the managed runtime, inspect global packages, or install the requested package. Successful output must include manifest validation, runtime validation, package plan, synced package, and changed-count diagnostics.
- The invalid fixture check is expected to fail with `Manifest validation failed:`. If it exits successfully, CI fails because the negative-path assertion did not prove npm-sync error handling.

## Managed Tool Sync Coverage

The expanded `tools` manifest shape always expands mandatory packages for OpenSpec skills (`skills@latest`), OmniRoute (`omniroute@latest`), and code-server (`code-server@latest`). Optional agent CLI sync adds selected optional CLIs when present. The first built-in optional IDs are `codex`, `qoder`, and `opencode`; custom entries must use valid npm package names and semver-compatible version selectors.

Validation happens before `npm list -g --depth=0 --json` and before any `npm install -g` mutation.

## Fixture Assumptions

The installed-runtime script writes a temporary manifest containing `@openai/codex` with `target: "latest"`. The managed runtime starts empty in the integration temp directory, so HagiScript should plan an `install` action, install the real Codex npm package through the managed runtime npm, and report `Changed: 1` after synchronization. The exact installed Codex version is intentionally not pinned because this fixture validates real latest-package installation.

The negative-path manifest is also created in the integration temp directory and intentionally uses an invalid package name. It does not contact the npm registry and keeps the failure assertion deterministic.
