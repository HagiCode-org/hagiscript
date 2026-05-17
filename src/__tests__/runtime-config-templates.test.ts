import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))

describe("runtime config templates", () => {
  it("renders the omniroute template with Windows paths as valid YAML", async () => {
    const rendered = await renderTemplate("omniroute-config.yaml", {
      RUNTIME_ROOT: quoteYamlString(
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\program"
      ),
      LISTEN_ADDR: quoteYamlString("127.0.0.1:39001"),
      DATA_DIR:
        quoteYamlString(
          "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\omniroute"
        ),
      LOGS_DIR:
        quoteYamlString(
          "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\omniroute\\logs"
        )
    })

    expect(() => parse(rendered)).not.toThrow()
    expect(parse(rendered)).toMatchObject({
      runtimeHome: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\program",
      dataDir:
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\omniroute",
      logDir:
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\omniroute\\logs"
    })
  })

  it("renders the code-server template with Windows paths as valid YAML", async () => {
    const rendered = await renderTemplate("code-server-config.yaml", {
      BIND_ADDR: quoteYamlString("127.0.0.1:8080"),
      DATA_DIR:
        quoteYamlString(
          "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\code-server"
        ),
      EXTENSIONS_DIR: quoteYamlString(
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\code-server\\extensions"
      )
    })

    expect(() => parse(rendered)).not.toThrow()
    expect(parse(rendered)).toMatchObject({
      "user-data-dir":
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\code-server",
      "extensions-dir":
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\code-server\\extensions"
    })
  })
})

async function renderTemplate(
  templateName: string,
  variables: Record<string, string>
): Promise<string> {
  const templatePath = path.resolve(repoRoot, "runtime/templates", templateName)
  const template = await readFile(templatePath, "utf8")
  return renderConfigTemplate(template, variables)
}

function renderConfigTemplate(template: string, values: Record<string, string>): string {
  const rendered = template.replace(/{{([A-Z0-9_]+)}}/g, (match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Missing template variable ${key}`)
    }

    return values[key]!
  })

  return rendered.endsWith("\n") ? rendered : `${rendered}\n`
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value)
}
