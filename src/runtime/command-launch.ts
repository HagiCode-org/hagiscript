import { extname } from "node:path";

export interface CommandLaunchOptions {
  platform?: NodeJS.Platform;
}

export interface RuntimeExecFileOptions {
  shell?: boolean;
}

export function normalizeCommandPath(commandPath: string): string {
  const trimmed = commandPath.trim();

  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];

    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

export function requiresShellLaunch(
  commandPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") {
    return false;
  }

  const extension = extname(normalizeCommandPath(commandPath)).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

export function getCommandLaunchOptions(
  commandPath: string,
  options: CommandLaunchOptions = {}
): RuntimeExecFileOptions {
  return requiresShellLaunch(commandPath, options.platform)
    ? { shell: true }
    : {};
}
