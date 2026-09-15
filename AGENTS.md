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
```

## Key Paths

- `src/`: core hagiscript source
- `dist/`: published build output

## Agent Guidelines

- Treat this as a published npm package; avoid breaking changes without version bumps.
- The manifest-driven workflow is the core contract; preserve backward compatibility.
- Keep the runtime layout and toolchain management consistent with the container bootstrap flow.
- If changing the manifest format or sync logic, ensure compatibility with `hagicode-local-deployment`.
- Node-less manifests may omit `paths.nodeRuntime`; released-service startup uses the managed .NET runtime directly. This engine/SDK contract is consumed by the separate `repos/hagicode-desktop` `fix-node-runtime-missing-startup` change; Desktop scope expansion and SDK republishing remain separate work.

## References

- `README.md`
