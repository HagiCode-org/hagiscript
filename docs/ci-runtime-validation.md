# CI Runtime Management Validation

The `runtime-management` job in `.github/workflows/ci.yml` validates the HagiScript runtime-management command surface in a real GitHub Actions runner. The job uses `actions/setup-node` only to install dependencies and build HagiScript itself; the Node runtime under test is installed, checked, and used by HagiScript.

## Command Syntax

The CI job invokes the compiled CLI with these commands:

```bash
node dist/cli.js install-node --target "$RUNNER_TEMP/hagiscript-node-runtime" --version 22
node dist/cli.js check-node --target "$RUNNER_TEMP/hagiscript-node-runtime"
node dist/cli.js npm-sync --runtime "$RUNNER_TEMP/hagiscript-node-runtime" --manifest fixtures/npm-sync/ci-install.json
```

There is no command-name mapping layer for this validation. The user-facing shorthand names `install-node`, `check-node`, and `npm-sync` are the actual CLI command names registered by HagiScript.

## Expected Failure Signals

- `install-node` fails the job when HagiScript cannot download, extract, or verify the managed Node.js runtime. Successful output must include `Node.js runtime installed successfully.`, `Node.js:`, and `npm:` diagnostics.
- `check-node` fails the job when the managed runtime does not expose executable `node` and `npm` commands. Successful output must include `Node.js runtime is valid.`, `node:`, and `npm:` diagnostics.
- `npm-sync` fails the job when HagiScript cannot validate the manifest, validate the managed runtime, inspect global packages, or install the requested package. Successful output must include manifest validation, runtime validation, package plan, synced package, and changed-count diagnostics.
- The invalid fixture check is expected to fail with `Manifest validation failed:`. If it exits successfully, CI fails because the negative-path assertion did not prove npm-sync error handling.

## Fixture Assumptions

`fixtures/npm-sync/ci-install.json` intentionally contains one small deterministic package, `is-number@7.0.0`. The managed runtime starts empty in `$RUNNER_TEMP`, so HagiScript should plan an `install` action and report `Changed: 1` after synchronization.

`fixtures/npm-sync/ci-invalid.json` intentionally uses an invalid package name. It does not contact the npm registry and keeps the failure assertion deterministic.
