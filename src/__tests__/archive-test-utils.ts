const CRC32_POLYNOMIAL = 0xedb88320

export interface ZipArchiveFixtureEntry {
  name: string
  contents: Buffer | string
}

export function createZipArchive(entries: ZipArchiveFixtureEntry[]): Buffer {
  const localRecords: Buffer[] = []
  const centralRecords: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const fileName = Buffer.from(entry.name, "utf8")
    const fileContents =
      typeof entry.contents === "string"
        ? Buffer.from(entry.contents, "utf8")
        : entry.contents
    const checksum = crc32(fileContents)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(fileContents.length, 18)
    localHeader.writeUInt32LE(fileContents.length, 22)
    localHeader.writeUInt16LE(fileName.length, 26)
    localHeader.writeUInt16LE(0, 28)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(fileContents.length, 20)
    centralHeader.writeUInt32LE(fileContents.length, 24)
    centralHeader.writeUInt16LE(fileName.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    localRecords.push(localHeader, fileName, fileContents)
    centralRecords.push(centralHeader, fileName)
    offset += localHeader.length + fileName.length + fileContents.length
  }

  const centralDirectory = Buffer.concat(centralRecords)
  const endOfCentralDirectory = Buffer.alloc(22)
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
  endOfCentralDirectory.writeUInt16LE(0, 4)
  endOfCentralDirectory.writeUInt16LE(0, 6)
  endOfCentralDirectory.writeUInt16LE(entries.length, 8)
  endOfCentralDirectory.writeUInt16LE(entries.length, 10)
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12)
  endOfCentralDirectory.writeUInt32LE(offset, 16)
  endOfCentralDirectory.writeUInt16LE(0, 20)

  return Buffer.concat([...localRecords, centralDirectory, endOfCentralDirectory])
}

function crc32(buffer: Buffer): number {
  let checksum = 0xffffffff

  for (const value of buffer) {
    checksum ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      const shouldApplyPolynomial = (checksum & 1) === 1
      checksum >>>= 1
      if (shouldApplyPolynomial) {
        checksum ^= CRC32_POLYNOMIAL
      }
    }
  }

  return (checksum ^ 0xffffffff) >>> 0
}
