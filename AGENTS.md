# Hagiscript - Agent Configuration

## Root Configuration

Inherits all behavior from `/AGENTS.md` at the monorepo root. Local rules extend or override the root file for this repository.

## Project Context

`@hagicode/hagiscript` is the CLI used to install and operate a managed HagiCode runtime. It manages the runtime layout, bundled services, managed npm tools, and the released backend server from a manifest-driven workflow. Published on npm.

## Working Directory

Run commands from `repos/hagiscript/`.

## Key Commands

```bash
npm install
npm run build
npm test
npm run lint
npm run format:check
npm run pack:check
npm run integration:installed-runtime
npm run build:sdk
npm run dev -- <command>
```

## Key Paths

- `src/`: core hagiscript source (`cli.ts`, `commands/`, `runtime/`)
- `src/__tests__/`: vitest unit tests (only this directory is collected)
- `runtime/`: packaged runtime manifest, install/verify/remove scripts, and config templates
- `sdk/`: `@hagicode/hagiscript-sdk` package (versioned in step with the CLI via `npm run sync-sdk-version`)
- `scripts/`: packaging, release-version, publish-prereq, playground and installed-runtime integration scripts
- `docs/`: CI runtime validation and Desktop-to-Hagiscript environment contract
- `dist/`: published build output

## Agent Guidelines

- Runtime: Node.js 24+ (`engines`, CI uses Node 24). CI (`.github/workflows/ci.yml`) runs `npm test`, build, `pack:check`, and `integration:installed-runtime` on Linux, Windows, and macOS; keep changes cross-platform (use `.cmd` shims and argument arrays, not shell parsing).
- `npm-publish.yml` publishes dev-tagged CLI and SDK builds; verify package contents with `npm run pack:check` / `pack:check:sdk` when changing `files`, `bin`, or `runtime/`.
- Treat this as a published npm package; avoid breaking changes without version bumps.
- The manifest-driven workflow is the core contract; preserve backward compatibility.
- Keep the runtime layout and toolchain management consistent with the container bootstrap flow.
- If changing the manifest format or sync logic, ensure compatibility with `hagicode-local-deployment`.
- Generic manifests may omit `paths.nodeRuntime` under their existing policy. Desktop PM2 manifests on Windows, Linux, and macOS require the packaged PM2-only Node runtime, while released-service server processes continue to use managed .NET.

## References

- `README.md`
- `docs/ci-runtime-validation.md`
- `docs/desktop-hagiscript-env-contract.md`
