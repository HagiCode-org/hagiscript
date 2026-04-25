# hagiscript

`hagiscript` is the npm package foundation for future Hagiscript language tooling. This initial package intentionally keeps runtime behavior small: it exposes version metadata, a baseline runtime-info API, and an executable CLI placeholder that can be built, tested, packed, and published safely.

## Installation Assumptions

- Node.js 20 or newer is required.
- npm is the package manager for this standalone repository.
- The initial package name is `hagiscript`. If npm name availability requires a scoped name later, update `package.json`, release workflows, and documentation together.
- npm publishing requires either trusted publishing with GitHub Actions provenance or an npm token compatible with `npm publish --provenance`.

## Usage

Run the CLI locally during development:

```bash
npm run dev -- --help
npm run dev -- info
```

After building, run the compiled CLI:

```bash
npm run build
node dist/cli.js --version
node dist/cli.js info
```

Use the library API from ESM consumers:

```ts
import { createRuntimeInfo, getPackageMetadata } from "hagiscript";

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

The package `exports` field points consumers to `dist/index.js` and `dist/index.d.ts`. The `bin.hagiscript` entry points to `dist/cli.js`.

## Package Verification

`npm run pack:check` runs a dry-run package inspection and fails if required runtime files are missing or source-only files are accidentally included. The published package should contain generated `dist` files and documentation, not raw tests, scripts, coverage, or temporary files.

## Release Automation

GitHub Actions provide three automation paths:

- `ci.yml` installs dependencies with `npm ci`, then runs lint, format check, tests, build, and package verification.
- `npm-publish.yml` publishes a unique prerelease version to the `dev` dist-tag from `main`.
- `npm-publish.yml` also publishes stable GitHub releases tagged as `vX.Y.Z` to the `latest` dist-tag after validating the tag against `package.json`.
- `release-drafter.yml` keeps a categorized release draft using `.github/release-drafter.yml`.

Before the first publish, configure npm trusted publishing or provide repository secrets required by the package registry policy.
