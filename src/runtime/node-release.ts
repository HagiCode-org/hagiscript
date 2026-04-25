import { mapNodePlatform, type NodePlatformTarget } from "./node-platform.js";

export const DEFAULT_NODE_MAJOR = 22;
export const OFFICIAL_NODE_DIST_BASE_URL = "https://nodejs.org/dist";

export interface NodeReleaseMetadata {
  version: string;
  lts?: string | boolean;
  files: string[];
  npm?: string;
}

export interface SelectedNodeArchive {
  release: NodeReleaseMetadata;
  version: string;
  platform: NodePlatformTarget;
  fileName: string;
  url: string;
}

export class NodeVersionSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeVersionSelectorError";
  }
}

export class NodeRuntimeSourcePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeRuntimeSourcePolicyError";
  }
}

export function normalizeVersionSelector(selector?: string): string {
  const trimmed = selector?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed.toLowerCase()
    : String(DEFAULT_NODE_MAJOR);
}

export function validateVersionSelector(selector?: string): void {
  const normalized = normalizeVersionSelector(selector);
  if (["lts", "latest", "current"].includes(normalized)) {
    return;
  }

  if (/^v?\d+(?:\.\d+\.\d+)?$/.test(normalized)) {
    return;
  }

  throw new NodeVersionSelectorError(
    `Invalid Node.js version selector: ${selector ?? ""}. Use lts, latest, current, 22, 22.11.0, or v22.11.0.`
  );
}

export async function fetchNodeReleaseMetadata(
  fetchImpl: typeof fetch = fetch,
  baseUrl = OFFICIAL_NODE_DIST_BASE_URL
): Promise<NodeReleaseMetadata[]> {
  assertOfficialNodeDistBaseUrl(baseUrl);
  const response = await fetchImpl(`${baseUrl}/index.json`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Node.js release metadata: HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Node.js release metadata response was not an array.");
  }

  return data.map(parseReleaseMetadata);
}

export function resolveNodeRelease(
  releases: NodeReleaseMetadata[],
  selector?: string
): NodeReleaseMetadata {
  validateVersionSelector(selector);
  const normalized = normalizeVersionSelector(selector);
  const sorted = [...releases].sort(compareReleaseDescending);

  const selected = selectRelease(sorted, normalized);
  if (!selected) {
    throw new NodeVersionSelectorError(
      `No Node.js release matched version selector: ${selector ?? DEFAULT_NODE_MAJOR}`
    );
  }

  return selected;
}

export function selectNodeArchive(
  releases: NodeReleaseMetadata[],
  selector?: string,
  platform = mapNodePlatform(),
  baseUrl = OFFICIAL_NODE_DIST_BASE_URL
): SelectedNodeArchive {
  assertOfficialNodeDistBaseUrl(baseUrl);
  const release = resolveNodeRelease(releases, selector);

  if (!release.files.includes(platform.nodeFileKey)) {
    throw new Error(
      `Node.js ${release.version} does not publish an archive for ${platform.nodeFileKey}.`
    );
  }

  const fileName = `node-${release.version}-${platform.nodeFileKey}.${platform.archiveExtension}`;
  const url = `${baseUrl}/${release.version}/${fileName}`;
  assertOfficialNodeArchiveUrl(url, baseUrl);

  return {
    release,
    version: release.version,
    platform,
    fileName,
    url
  };
}

export function assertOfficialNodeDistBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new NodeRuntimeSourcePolicyError(
      `Node.js runtime source is not a valid URL: ${baseUrl}`
    );
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "nodejs.org") {
    throw new NodeRuntimeSourcePolicyError(
      `Node.js runtime source is not governed by the official distribution host: ${baseUrl}`
    );
  }
}

function assertOfficialNodeArchiveUrl(url: string, baseUrl: string): void {
  assertOfficialNodeDistBaseUrl(baseUrl);
  const parsedUrl = new URL(url);
  const parsedBaseUrl = new URL(baseUrl);

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== parsedBaseUrl.hostname ||
    !parsedUrl.pathname.startsWith("/dist/v")
  ) {
    throw new NodeRuntimeSourcePolicyError(
      `Node.js archive URL violates source policy: ${url}`
    );
  }
}

function parseReleaseMetadata(value: unknown): NodeReleaseMetadata {
  if (typeof value !== "object" || value === null) {
    throw new Error("Node.js release metadata item was not an object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || !Array.isArray(record.files)) {
    throw new Error(
      "Node.js release metadata item is missing version or files."
    );
  }

  return {
    version: record.version,
    lts:
      typeof record.lts === "string" || typeof record.lts === "boolean"
        ? record.lts
        : undefined,
    files: record.files.filter(
      (file): file is string => typeof file === "string"
    ),
    npm: typeof record.npm === "string" ? record.npm : undefined
  };
}

function selectRelease(
  releases: NodeReleaseMetadata[],
  selector: string
): NodeReleaseMetadata | undefined {
  if (selector === "lts") {
    return releases.find((release) => Boolean(release.lts));
  }

  if (selector === "latest" || selector === "current") {
    return releases[0];
  }

  if (/^v?\d+$/.test(selector)) {
    const major = Number(selector.replace(/^v/, ""));
    return releases.find(
      (release) => getMajorVersion(release.version) === major
    );
  }

  const exact = selector.startsWith("v") ? selector : `v${selector}`;
  return releases.find((release) => release.version === exact);
}

function compareReleaseDescending(
  left: NodeReleaseMetadata,
  right: NodeReleaseMetadata
): number {
  const leftParts = parseVersionParts(left.version);
  const rightParts = parseVersionParts(right.version);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return rightParts[index] - leftParts[index];
    }
  }

  return 0;
}

function getMajorVersion(version: string): number | undefined {
  return parseVersionParts(version)[0];
}

function parseVersionParts(version: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return [0, 0, 0];
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
