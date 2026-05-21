import extractZip from "extract-zip"
import { resolve } from "node:path"

export async function extractZipArchive(
  archivePath: string,
  destination: string
): Promise<void> {
  await extractZip(archivePath, {
    dir: resolve(destination)
  })
}
