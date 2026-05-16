#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { execa } from "execa"
import { parse, stringify } from "yaml"

const repoRoot = process.cwd()

// All parameters are configurable via env vars to support multiple instances.
const instanceName = process.env.PLAYGROUND_INSTANCE_NAME ?? "hagiscript_playground"
const runtimeRoot = process.env.PLAYGROUND_RUNTIME_ROOT ?? "./playground/runtime-root"
const manifestPath = process.env.PLAYGROUND_MANIFEST_PATH ?? "./playground/generated/manifest.yaml"
const serverPort = process.env.PLAYGROUND_SERVER_PORT ?? "39151"
const omniRoutePort = process.env.PLAYGROUND_OMNIROUTE_PORT ?? "39001"
const codeServerPort = process.env.PLAYGROUND_CODE_SERVER_PORT ?? "8080"

const resolvedManifestPath = resolve(repoRoot, manifestPath)

await execa(
  "npm",
  [
    "run",
    "dev",
    "--",
    "manifest",
    "init",
    manifestPath,
    "--runtime-root",
    runtimeRoot,
    "--npm-package-version",
    "@github/copilot=1.0.47",
    "--server-active-version",
    "0.1.0-beta.60",
    "--force"
  ],
  {
    cwd: repoRoot,
    stdio: "inherit"
  }
)

const parsed = parse(await readFile(resolvedManifestPath, "utf8"))
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error(`Generated playground manifest is invalid: ${resolvedManifestPath}`)
}

parsed.runtime = {
  ...(parsed.runtime ?? {}),
  name: "hagicode-runtime-playground",
  hagicodeInstance: instanceName
}

const components = Array.isArray(parsed.components) ? parsed.components : []

function patchComponentPm2Env(name, extraEnv) {
  const component = components.find(
    (c) => c && typeof c === "object" && c.name === name
  )
  if (!component || typeof component !== "object" || Array.isArray(component)) {
    return
  }
  const existingEnv =
    component.pm2 && typeof component.pm2 === "object" && !Array.isArray(component.pm2)
      ? (component.pm2.env ?? {})
      : {}
  component.pm2 = {
    ...(component.pm2 ?? {}),
    env: { ...existingEnv, ...extraEnv }
  }
}

patchComponentPm2Env("server", {
  ASPNETCORE_ENVIRONMENT: "Production",
  ASPNETCORE_URLS: `http://127.0.0.1:${serverPort}`
})

patchComponentPm2Env("omniroute", {
  OMNIROUTE_LISTEN_PORT: omniRoutePort
})

patchComponentPm2Env("code-server", {
  CODE_SERVER_BIND_PORT: codeServerPort
})

await mkdir(dirname(resolvedManifestPath), { recursive: true })
await writeFile(resolvedManifestPath, stringify(parsed), "utf8")
process.stdout.write(`Generated playground manifest: ${resolvedManifestPath}\n`)
process.stdout.write(`  instance=${instanceName}  runtime-root=${runtimeRoot}\n`)
process.stdout.write(`  ports: omniroute=${omniRoutePort}  code-server=${codeServerPort}  server=${serverPort}\n`)