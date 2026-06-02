import extractZip from "extract-zip"
import process from "node:process"
import { resolve } from "node:path"
import { spawn } from "node:child_process"

const windowsTarCommands = ["tar.exe", "tar"]
const windowsPowerShellCommands = ["pwsh", "powershell.exe", "powershell"]

export async function extractZipArchive(archivePath, destination) {
  const resolvedDestination = resolve(destination)
  const nativeFailures = []

  if (process.platform === "win32") {
    const nativeResult = await tryExtractZipArchiveWithNativeTools(
      archivePath,
      resolvedDestination
    )
    if (nativeResult.success) {
      return
    }

    nativeFailures.push(...nativeResult.failures)
  }

  try {
    await extractZip(archivePath, {
      dir: resolvedDestination
    })
  } catch (error) {
    const archiveError = error instanceof Error ? error : new Error(String(error))
    const nativeSummary =
      nativeFailures.length > 0
        ? ` Native attempts: ${nativeFailures.join(" | ")}.`
        : ""
    throw new Error(
      `Failed to extract zip archive ${archivePath}: ${archiveError.message}.${nativeSummary}`
    )
  }
}

async function tryExtractZipArchiveWithNativeTools(archivePath, destination) {
  const failures = []

  for (const command of windowsTarCommands) {
    const result = await tryRunZipExtractionCommand(command, [
      "-xf",
      archivePath,
      "-C",
      destination
    ])
    if (result.success) {
      return { success: true, failures }
    }
    failures.push(result.failure)
  }

  for (const command of windowsPowerShellCommands) {
    const result = await tryRunZipExtractionCommand(command, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildExpandArchiveCommand(archivePath, destination)
    ])
    if (result.success) {
      return { success: true, failures }
    }
    failures.push(result.failure)
  }

  return { success: false, failures }
}

async function tryRunZipExtractionCommand(command, args) {
  try {
    await runCommand(command, args)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      failure: formatCommandFailure(command, error)
    }
  }
}

function buildExpandArchiveCommand(archivePath, destination) {
  const escapedArchivePath = escapePowerShellSingleQuotedString(archivePath)
  const escapedDestination = escapePowerShellSingleQuotedString(destination)
  return `Expand-Archive -LiteralPath '${escapedArchivePath}' -DestinationPath '${escapedDestination}' -Force`
}

function escapePowerShellSingleQuotedString(value) {
  return String(value).replaceAll("'", "''")
}

function formatCommandFailure(command, error) {
  if (error instanceof Error) {
    return `${command}: ${error.message}`
  }

  return `${command}: ${String(error)}`
}

function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", rejectCommand)
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr, code, signal })
        return
      }

      rejectCommand(
        new Error(
          `${command} exited with code ${code ?? "unknown"}${
            signal ? ` (signal=${signal})` : ""
          }: ${(stderr || stdout).trim() || "unknown error"}`
        )
      )
    })
  })
}
