# Desktop To Hagiscript Environment Contract

This document describes the effective environment-variable contract for the Desktop -> Hagiscript -> PM2 -> backend startup flow.

It answers three ownership questions for each variable:

- `desktop generated`: Desktop computes the value before handing control to Hagiscript.
- `hagiscript generated`: Hagiscript computes the value during runtime/PM2 resolution.
- `hagiscript passthrough`: Desktop may provide the value, and Hagiscript carries it forward without interpreting it.

## Flow Summary

1. Desktop builds managed backend variables in `web-service-env.ts`.
2. Desktop merges `process.env`, shell/console env, `this.config.env`, and the managed backend variables.
3. Desktop applies final startup overrides in `buildHagiscriptServiceEnvironment()`, notably `ASPNETCORE_ENVIRONMENT` and `ASPNETCORE_URLS`.
4. Desktop writes that resolved `serviceEnv` into the temporary Hagiscript override manifest as `components[].pm2.env`.
5. Hagiscript loads the manifest, merges `pm2.env` with service-specific overrides, then rebuilds runtime-owned variables such as `PATH`, `PM2_HOME`, and the `HAGISCRIPT_RUNTIME_*` contract.
6. On managed PM2 `start` and `restart`, Hagiscript stops and deletes any same-name PM2 app before generating fresh launch metadata and starting a replacement instance, so the current resolved env/config always wins over stale PM2 app state.

## Desktop-Managed Backend Variables

These are part of the explicit Desktop backend contract. In the Desktop-managed startup path, Desktop is the source of truth for these values.

| Variable | Ownership | Desktop source | Hagiscript behavior | Notes |
| --- | --- | --- | --- | --- |
| `ASPNETCORE_URLS` | `desktop generated` | `buildManagedServiceEnv()` and final Desktop override in `buildHagiscriptServiceEnvironment()` | Passed into PM2 env. In standalone `hagiscript server start`, Hagiscript also computes it from `server-config.json`. | Effective backend bind URL. |
| `ASPNETCORE_ENVIRONMENT` | `desktop generated` | `buildHagiscriptServiceEnvironment()` | Passed through unchanged. | Desktop defaults to `Production` if not already set. |
| `Urls` | `desktop generated` | `buildManagedServiceEnv()` | Passed into PM2 env. In standalone `hagiscript server start`, Hagiscript now also generates it from server config. | Secondary ASP.NET URL key kept in sync with `ASPNETCORE_URLS`. |
| `DATADIR` | `desktop generated` | `buildManagedServiceEnv()` | Passed into PM2 env. In standalone `hagiscript server start`, Hagiscript now generates it as an absolute `server-data/data` path under the shared server data root. | Backend system data directory consumed by `hagicode-core`; its parent becomes the runtime root that contains `saves/`. |
| `ConnectionStrings__Default` | `desktop generated` | `buildManagedServiceEnv()` from YAML or inherited env | `hagiscript passthrough` | Optional SQLite connection-string override. |
| `AI__Providers__DefaultProvider` | `desktop generated` | `buildManagedServiceEnv()` default | `hagiscript passthrough` | Desktop defaults this to `ClaudeCodeCli`. |
| `HAGICODE_LOG_FORMAT` | `desktop generated` | `buildManagedServiceEnv()` default | `hagiscript passthrough` | Desktop defaults this to `plain`. |
| `HAGICODE_LANGUAGE` | `desktop generated` | `buildManagedServiceEnv()` from Desktop language preference | `hagiscript passthrough` | Desktop normalizes UI language for the backend. |
| `HAGICODE_STEAM_INTEGRATION_ENABLED` | `desktop generated` | `resolveSteamIntegration()` -> `buildManagedServiceEnv()` | `hagiscript passthrough` | Steam distribution-mode flag. |
| `HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED` | `desktop generated` | `resolveSteamIntegration()` -> `buildManagedServiceEnv()` | `hagiscript passthrough` | Steam achievement sync flag. |
| `VsCodeServer__Host` | `desktop generated` | `buildManagedServiceEnv()` from Desktop code-server config | `hagiscript passthrough` | |
| `VsCodeServer__Port` | `desktop generated` | `buildManagedServiceEnv()` from Desktop code-server config | `hagiscript passthrough` | |
| `VsCodeServer__AuthMode` | `desktop generated` | `buildManagedServiceEnv()` from Desktop code-server config | `hagiscript passthrough` | |
| `VsCodeServer__Secret` | `desktop generated` | `buildManagedServiceEnv()` from Desktop code-server config | `hagiscript passthrough` | Sensitive value. |
| `VsCodeServer__SecretSource` | `desktop generated` | `buildManagedServiceEnv()` from Desktop code-server config | `hagiscript passthrough` | |
| `VsCodeServer__Source` | `desktop generated` | `buildManagedServiceEnv()` from Desktop code-server config | `hagiscript passthrough` | |
| `VsCodeServer__SourceLocked` | `desktop generated` | `buildManagedServiceEnv()` from Desktop code-server config | `hagiscript passthrough` | |
| `SystemManagedVaults__AdditionalDirectories__*` | `desktop generated` | `buildDesktopSystemVaultEnv()` | `hagiscript passthrough` | Hierarchical ASP.NET Core env keys for Desktop-owned vault directories. |

## Hagiscript-Generated Runtime And PM2 Variables

These values are owned by Hagiscript even in the Desktop-managed flow.

| Variable group | Ownership | Source in Hagiscript | Notes |
| --- | --- | --- | --- |
| `PATH` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` + `prependPathEntries()` | Hagiscript rebuilds `PATH` so managed Node, managed npm, and runtime bin entries take precedence. Inherited shell `PATH` is not authoritative. |
| `PM2_HOME` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Points PM2 state into the runtime data boundary. |
| `hagicode_pm2_name` | `hagiscript generated` | `buildManagedPm2Environment()` | The server PM2 instance-name variable. The manifest decides the key name; the server currently uses `hagicode_pm2_name`. |
| `HAGICODE_RUNTIME_HOME` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime program home. |
| `HAGICODE_RUNTIME_DATA_HOME` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime data home for the current managed service. |
| `HAGISCRIPT_RUNTIME_ROOT` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime root path. |
| `HAGISCRIPT_RUNTIME_BIN_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime bin directory. |
| `HAGISCRIPT_RUNTIME_CONFIG_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime config directory. |
| `HAGISCRIPT_RUNTIME_LOGS_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime logs directory. |
| `HAGISCRIPT_RUNTIME_DATA_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime shared data directory. |
| `HAGISCRIPT_RUNTIME_STATE_PATH` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime state file. |
| `HAGISCRIPT_RUNTIME_TEMPLATE_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Template root used by runtime scripts. |
| `HAGISCRIPT_RUNTIME_COMPONENT_*` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Component name, type, version, root, config dir, data dir, logs dir, and PM2 home. |
| `HAGISCRIPT_RUNTIME_NODE_RUNTIME_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Managed Node runtime location. |
| `HAGISCRIPT_RUNTIME_DOTNET_RUNTIME_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Managed .NET runtime location. |
| `HAGISCRIPT_RUNTIME_NPM_PREFIX` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Managed npm prefix. |
| `HAGISCRIPT_RUNTIME_RELEASED_SERVICE_*` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Released backend payload metadata such as DLL path, working directory, config root, runtime files dir, and optional start script. |
| `HAGISCRIPT_DOWNLOAD_CACHE` / `HAGISCRIPT_DOWNLOAD_CACHE_DIR` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime download-cache contract. |
| `HAGISCRIPT_RUNTIME_SCRIPT_BASENAME` | `hagiscript generated` | `buildManagedRuntimeEnvironment()` | Runtime script identity for lifecycle scripts. |

## Open-Ended Passthrough Rule

Desktop also forwards an open-ended set of ambient variables into Hagiscript startup:

- inherited `process.env`
- shell/console env loaded by Desktop
- `this.config.env`

`HagiscriptRuntimeContextResolver.normalizeManifestEnv()` copies every non-empty string key from Desktop `serviceEnv` into the temporary manifest `pm2.env` block.

That means any non-contracted key may still reach PM2 and the backend, but it should be treated as ambient passthrough rather than a stable contract.

Examples include host-machine tokens, editor integration ports, and other user-session variables.

## Effective Precedence

When the same key appears in multiple places, the effective precedence for PM2 startup is:

1. Desktop ambient env merge: `process.env` + console env + `this.config.env`
2. Desktop managed backend env from `buildManagedServiceEnv()`
3. Desktop final startup override from `buildHagiscriptServiceEnvironment()`
4. Hagiscript `components[].pm2.env` loaded from the override manifest
5. Hagiscript service-specific overrides from `server-manager.ts`
6. Hagiscript runtime-owned env rebuild from `buildManagedRuntimeEnvironment()`
7. Fresh PM2 app creation on each managed `start`/`restart`, which reapplies the resolved environment and regenerated released-service launch files instead of reusing a previous PM2 app record

The last two steps are why runtime-owned keys such as `PATH`, `PM2_HOME`, `HAGICODE_RUNTIME_HOME`, and `HAGISCRIPT_RUNTIME_*` should always be considered Hagiscript-owned, even when Desktop launches the flow. PM2 process state is recreated, but runtime payloads and runtime data directories are preserved in place.
