export type NodeOperatingSystem = "win" | "linux" | "darwin";
export type NodeArchitecture = "x64" | "arm64";

export interface NodePlatformTarget {
  os: NodeOperatingSystem;
  arch: NodeArchitecture;
  nodeFileKey: `${NodeOperatingSystem}-${NodeArchitecture}`;
  archiveExtension: "zip" | "tar.xz";
  executableName: "node.exe" | "node";
  npmExecutableName: "npm.cmd" | "npm";
}

export class UnsupportedNodePlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedNodePlatformError";
  }
}

export function mapNodePlatform(
  platform = process.platform,
  arch = process.arch
): NodePlatformTarget {
  const os = mapOperatingSystem(platform);
  const nodeArch = mapArchitecture(arch);

  return {
    os,
    arch: nodeArch,
    nodeFileKey: `${os}-${nodeArch}`,
    archiveExtension: os === "win" ? "zip" : "tar.xz",
    executableName: os === "win" ? "node.exe" : "node",
    npmExecutableName: os === "win" ? "npm.cmd" : "npm"
  };
}

function mapOperatingSystem(platform: string): NodeOperatingSystem {
  switch (platform) {
    case "win32":
      return "win";
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    default:
      throw new UnsupportedNodePlatformError(
        `Unsupported operating system for Node.js runtime archives: ${platform}`
      );
  }
}

function mapArchitecture(arch: string): NodeArchitecture {
  switch (arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      throw new UnsupportedNodePlatformError(
        `Unsupported CPU architecture for Node.js runtime archives: ${arch}`
      );
  }
}
