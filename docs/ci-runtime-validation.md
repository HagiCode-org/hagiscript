# CI Runtime Management Validation

The `.github/workflows/ci.yml` workflow validates HagiScript on Linux, Windows, and macOS GitHub-hosted runners. Both `validate` and `runtime-management` use the same operating-system matrix:

- `ubuntu-latest` validates POSIX paths, Unix permission bits, symlink resolution, package build output, unit tests, package contents, and installed-package runtime behavior.
- `windows-latest` validates `.cmd` command shims, managed `node.exe` and `npm.cmd` resolution, Windows-safe argument arrays, installed-package runtime behavior, and skip handling for runner capabilities such as symlink creation privilege.
- `macos-latest` validates POSIX paths on macOS, Unix permission bits, symlink resolution, installed-package runtime behavior, and architecture diagnostics that show whether the runner is `arm64` or `x64`.

The `validate` job runs the full contributor-facing sequence: `npm ci`, `npm test`, `npm run build`, `npm run pack:check`, and `npm run integration:installed-runtime`. The `runtime-management` job preserves the focused runtime path by building HagiScript first, then running the installed-package integration test.

## Command Syntax

The CI jobs run `npm run integration:installed-runtime`. That script packs the current build with `npm pack`, installs the tarball into a temporary npm project, and invokes the installed package binary at `node_modules/.bin/hagiscript` on POSIX or `node_modules/.bin/hagiscript.cmd` on Windows with these command shapes:

```bash
hagiscript install-node --target "$TEMP/custom-node-runtime"
hagiscript check-node --target "$TEMP/custom-node-runtime"
hagiscript npm-sync --runtime "$TEMP/custom-node-runtime" --manifest "$TEMP/manifest.json" --registry-mirror "https://registry.npmmirror.com/"
```

The installed-runtime integration script uses the npmmirror/Taobao registry mirror by default for npm-sync package inventory and installation. Override it with `HAGISCRIPT_INTEGRATION_REGISTRY_MIRROR` when validating another production mirror.

This intentionally validates the package installation surface a user or downstream automation consumes, including the `bin.hagiscript` entry in `package.json`. It does not call `node dist/cli.js` directly for the behavior under test.

`npm-sync --runtime` is the compatibility path for CI fixtures that install a known runtime in `$RUNNER_TEMP`. Product-managed synchronization can omit `--runtime`; HagiScript then verifies or installs its default managed runtime and uses that runtime's npm executable. In both paths, package inventory and mutation must use the resolved runtime npm rather than ambient shell `PATH`.

There is no command-name mapping layer for this validation. The user-facing shorthand names `install-node`, `check-node`, and `npm-sync` are the actual CLI command names registered by HagiScript.

## Platform-Specific Checks

The integration harness emits platform diagnostics before running package actions. The diagnostics include `process.platform`, `process.arch`, OS type and release, Node.js version, npm version, temp root, package name and version, `RUNNER_OS`, `RUNNER_ARCH`, and `GITHUB_RUN_ID` when available. macOS architecture is visible through both `process.arch` and `RUNNER_ARCH`.

Executable resolution is validated before and after managed runtime installation. Windows expects `npm.cmd`, `hagiscript.cmd`, managed `node.exe`, and managed `npm.cmd`. Linux and macOS expect suffix-free `npm`, `hagiscript`, `node`, and `npm` paths under the POSIX `bin` directory.

The shell execution check uses `execa` with command and argument arrays. It intentionally avoids depending on interactive shell parsing, PowerShell quoting, Bash expansion, or CMD-specific behavior.

Filesystem permission checks validate Unix mode-bit behavior on Linux and macOS. Windows runners do not provide equivalent POSIX mode-bit execution semantics, so the check records a skipped capability instead of reporting a false success.

Symlink checks create a file symlink and verify that `realpath` resolves to the expected target. If Windows symlink creation is unavailable because the runner lacks privilege, the check records a skip with the underlying reason. If symlink creation succeeds but resolves incorrectly, the integration fails.

## Reporting And Artifacts

Major integration stages are named in logs and summaries:

- `platform diagnostics`
- `package packing`
- `dependency setup`
- `installed binary execution`
- `shell command execution`
- `runtime install`
- `runtime check`
- `platform-specific checks`
- `npm-sync`
- `npm-sync invalid manifest`

Each integration run writes a consistent Markdown summary with platform, architecture, runner metadata, Node.js and npm versions, temp root, package version, stage outcomes, skipped checks, and final result. In GitHub Actions, the summary is appended to the job summary and copied into `.ci-artifacts` for upload.

The workflow uploads diagnostics with platform-specific artifact names such as `hagiscript-validate-linux-diagnostics`, `hagiscript-validate-windows-diagnostics`, and `hagiscript-runtime-management-macos-diagnostics`. Artifacts include stage logs and the integration summary when the reporting step is reached.

Skipped checks are listed under `Skipped Checks`. They are not reported as successful validations. A skipped check means the runner did not expose a capability that can be required consistently, while a passed stage means the validation actually ran and succeeded.

## Expected Failure Signals

- `install-node` fails the job when HagiScript cannot download, extract, or verify the managed Node.js runtime. Successful output must include `Node.js runtime installed successfully.`, `Node.js:`, and `npm:` diagnostics.
- `check-node` fails the job when the managed runtime does not expose executable `node` and `npm` commands. Successful output must include `Node.js runtime is valid.`, `node:`, and `npm:` diagnostics.
- `npm-sync` fails the job when HagiScript cannot validate the manifest, validate or install the managed runtime, inspect global packages, or install the requested package. Successful output must include manifest validation, runtime validation, registry mirror, package plan, synced package, and changed-count diagnostics.
- The invalid fixture check is expected to fail with `Manifest validation failed:`. If it exits successfully, CI fails because the negative-path assertion did not prove npm-sync error handling.
- Platform-specific check failures identify the named stage and include the failing assertion in the integration summary.

## Local Reproduction

Run local checks from `repos/hagiscript`:

```bash
npm test
npm run build
npm run pack:check
npm run integration:installed-runtime
```

Override the npm registry mirror used by the npm-sync fixture:

```bash
HAGISCRIPT_INTEGRATION_REGISTRY_MIRROR="https://registry.npmjs.org/" npm run integration:installed-runtime
```

Preserve the temporary integration directory for debugging:

```bash
HAGISCRIPT_KEEP_INTEGRATION_TEMP=1 npm run integration:installed-runtime
```

Write the generated summary to a known location:

```bash
HAGISCRIPT_INTEGRATION_SUMMARY_PATH=".ci-artifacts/local-integration-summary.md" npm run integration:installed-runtime
```

Local runs use the contributor's current operating system and do not require GitHub Actions environment variables. When `RUNNER_OS`, `RUNNER_ARCH`, or `GITHUB_RUN_ID` are absent, diagnostics mark the run as local.

## Managed Tool Sync Coverage

The expanded `tools` manifest shape always expands mandatory packages from the internal pinned catalog config: OpenSpec skills (`skills@1.5.1`), OmniRoute (`omniroute@3.6.9`), and code-server (`code-server@4.117.0`). Optional agent CLI sync adds selected optional CLIs when present. The first built-in optional IDs are `codex` (`@openai/codex@0.125.0`), `claude-code` (`@anthropic-ai/claude-code@2.1.119`), `fission-openspec` (`@fission-ai/openspec@1.3.1`), `qoder` (`@qoder-ai/qodercli@0.1.48`), and `opencode` (`opencode-ai@1.14.24`); custom entries must use valid npm package names and semver-compatible version selectors.

Validation happens before `npm list -g --depth=0 --json` and before any `npm install -g` mutation.

## Fixture Assumptions

The installed-runtime script writes a temporary manifest containing `@openai/codex` with `target: "latest"`. The managed runtime starts empty in the integration temp directory, so HagiScript should plan an `install` action, install the real Codex npm package through the managed runtime npm and configured registry mirror, and report `Changed: 1` after synchronization. The exact installed Codex version is intentionally not pinned because this fixture validates real latest-package installation.

The negative-path manifest is also created in the integration temp directory and intentionally uses an invalid package name. It does not contact the npm registry and keeps the failure assertion deterministic.
