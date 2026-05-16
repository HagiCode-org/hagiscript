#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { execa } from "execa"
import { parse, stringify } from "yaml"

const repoRoot = process.cwd()
const manifestPath = "./playground/generated/manifest.yaml"
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
    "./playground/runtime-root",
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
  hagicodeInstance: "hagiscript_playground"
}

const components = Array.isArray(parsed.components) ? parsed.components : []
const serverComponent = components.find(
  (component) => component && typeof component === "object" && component.name === "server"
)

if (!serverComponent || typeof serverComponent !== "object" || Array.isArray(serverComponent)) {
  throw new Error(`Generated playground manifest is missing the server component: ${resolvedManifestPath}`)
}

serverComponent.pm2 = {
  ...(serverComponent.pm2 ?? {}),
  env: {
    ...((serverComponent.pm2 && typeof serverComponent.pm2 === "object" && !Array.isArray(serverComponent.pm2)
      ? serverComponent.pm2.env
      : undefined) ?? {}),
    ASPNETCORE_ENVIRONMENT: "Production",
    ASPNETCORE_URLS: "http://127.0.0.1:39151"
  }
}

await mkdir(dirname(resolvedManifestPath), { recursive: true })
await writeFile(resolvedManifestPath, stringify(parsed), "utf8")
process.stdout.write(`Generated playground manifest: ${resolvedManifestPath}\n`)