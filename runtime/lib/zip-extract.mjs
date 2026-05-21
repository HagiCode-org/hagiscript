import extractZip from "extract-zip"
import path from "node:path"

export async function extractZipArchive(archivePath, destination) {
  await extractZip(archivePath, {
    dir: path.resolve(destination)
  })
}
