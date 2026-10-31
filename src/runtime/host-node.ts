import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";

export interface HostNodeLookupOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

// Lists `node` candidates in PATH order without touching the file system.
// Relative entries are skipped so a binary is never picked up from the working directory.
// On Windows only `node.exe` is considered: `.cmd` shims cannot be run as PM2's Node executable.
export function listHostNodeCandidates(
  options: HostNodeLookupOptions = {}
): string[] {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  const pathModule = isWindows ? path.win32 : path.posix;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const executableName = isWindows ? "node.exe" : "node";

  const candidates: string[] = [];
  for (const rawEntry of pathEnv.split(isWindows ? ";" : ":")) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !pathModule.isAbsolute(entry)) {
      continue;
    }
    candidates.push(pathModule.join(entry, executableName));
  }

  return candidates;
}

// Returns the first existing executable `node` on PATH, or undefined.
// It probes the file system directly and never spawns a shell or `which`/`where`.
export async function findHostNode(
  options: HostNodeLookupOptions = {}
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  for (const candidate of listHostNodeCandidates({ ...options, platform })) {
    if (await isExecutableNodeFile(candidate, platform)) {
      return candidate;
    }
  }

  return undefined;
}

// True when `candidate` is a regular file that PM2 can run as Node. On Windows existence is the check (no execute bit).
export async function isExecutableNodeFile(
  candidate: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return false;
    }

    // Windows has no execute bit; existence of a `node.exe` file is the check there.
    if (platform !== "win32") {
      await access(candidate, constants.X_OK);
    }

    return true;
  } catch {
    return false;
  }
}
