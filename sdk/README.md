# hagiscript-sdk

`hagiscript-sdk` publishes the programmatic Hagiscript APIs without the CLI layer from `@hagicode/hagiscript`.

## Install

```bash
npm install hagiscript-sdk
```

## Usage

```ts
import {
  createRuntimeInfo,
  installRuntime,
  syncNpmGlobals
} from "hagiscript-sdk";

const info = createRuntimeInfo();
```

This package exposes the same public SDK surface as `@hagicode/hagiscript` while avoiding CLI-only dependencies such as `commander`.

For the complete API and workflow documentation, refer to the main package documentation in the `@hagicode/hagiscript` repository.
