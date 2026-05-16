import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))

describe("runtime config templates", () => {
  it("renders the omniroute template with Windows paths as valid YAML", async () => {
    const rendered = await renderTemplate("omniroute-config.yaml", {
      RUNTIME_ROOT: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\program",
      DATA_DIR:
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\omniroute",
      LOGS_DIR:
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\omniroute\\logs"
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
      DATA_DIR:
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\code-server"
    })

    expect(() => parse(rendered)).not.toThrow()
    expect(parse(rendered)).toMatchObject({
      "user-data-dir":
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\code-server",
      "extensions-dir":
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\managed-runtime\\runtime-data\\components\\services\\code-server/extensions"
    })
  })
})

async function renderTemplate(
  templateName: string,
  variables: Record<string, string>
): Promise<string> {
  const templateRoot =
    templateName === "omniroute-config.yaml"
      ? path.resolve(repoRoot, "../vendered/packages/omniroute/templates")
      : path.resolve(repoRoot, "../vendered/packages/code-server/templates")
  const template = await readFile(path.join(templateRoot, templateName), "utf8")
  let rendered = template

  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value)
  }

  return rendered
}
