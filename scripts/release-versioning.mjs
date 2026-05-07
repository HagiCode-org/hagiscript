import process from "node:process";

export function parseStableVersion(value, label = "version") {
  const match = String(value).match(
    /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:[-+].*)?$/
  );

  if (!match?.groups) {
    throw new Error(`Unsupported ${label}: ${value}`);
  }

  return `${match.groups.major}.${match.groups.minor}.${match.groups.patch}`;
}

export function extractStableVersionFromTag(tagName) {
  const match = String(tagName).match(
    /^v(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/
  );

  if (!match?.groups) {
    throw new Error(
      `Release tags must use the stable vX.Y.Z format. Received: ${tagName}`
    );
  }

  return `${match.groups.major}.${match.groups.minor}.${match.groups.patch}`;
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left, "left version").split(".").map(Number);
  const rightParts = parseStableVersion(right, "right version").split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function buildDevVersion(baseVersion, env = process.env) {
  const normalizedBaseVersion = parseStableVersion(baseVersion);
  const runNumber = env.GITHUB_RUN_NUMBER ?? "0";
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  const shortSha = (env.GITHUB_SHA ?? "local")
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, "")
    .slice(0, 7);

  if (!/^\d+$/.test(runNumber)) {
    throw new Error(`GITHUB_RUN_NUMBER must be numeric. Received: ${runNumber}`);
  }

  if (!/^\d+$/.test(runAttempt)) {
    throw new Error(
      `GITHUB_RUN_ATTEMPT must be numeric. Received: ${runAttempt}`
    );
  }

  if (shortSha.length === 0) {
    throw new Error(
      "GITHUB_SHA must contain at least one alphanumeric character."
    );
  }

  return `${normalizedBaseVersion}-dev.${runNumber}.${runAttempt}.${shortSha}`;
}

export function selectNextUnreleasedReleaseVersion(releases) {
  const stablePublishedVersions = [];
  const stableDraftVersions = [];

  for (const release of releases) {
    if (!release || typeof release !== "object") {
      continue;
    }

    const tagName =
      typeof release.tag_name === "string" ? release.tag_name.trim() : "";
    if (!tagName) {
      continue;
    }

    let version;
    try {
      version = extractStableVersionFromTag(tagName);
    } catch {
      continue;
    }

    if (release.draft === true) {
      stableDraftVersions.push(version);
      continue;
    }

    if (release.prerelease === true) {
      continue;
    }

    stablePublishedVersions.push(version);
  }

  const latestPublished = stablePublishedVersions.sort(compareStableVersions).at(-1);
  const candidates = stableDraftVersions
    .filter((version) =>
      latestPublished ? compareStableVersions(version, latestPublished) > 0 : true
    )
    .sort(compareStableVersions);

  return candidates.at(-1);
}

export function selectLatestPublishedReleaseVersion(releases) {
  const stablePublishedVersions = [];

  for (const release of releases) {
    if (!release || typeof release !== "object") {
      continue;
    }

    const tagName =
      typeof release.tag_name === "string" ? release.tag_name.trim() : "";
    if (!tagName || release.draft === true || release.prerelease === true) {
      continue;
    }

    try {
      stablePublishedVersions.push(extractStableVersionFromTag(tagName));
    } catch {
      continue;
    }
  }

  return stablePublishedVersions.sort(compareStableVersions).at(-1);
}

export function incrementPatchVersion(version) {
  const [major, minor, patch] = parseStableVersion(version)
    .split(".")
    .map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

export async function fetchRepositoryReleases({
  repository,
  githubToken,
  fetchImpl = globalThis.fetch
}) {
  if (!repository) {
    throw new Error("repository is required to load releases.");
  }

  if (!githubToken) {
    throw new Error("githubToken is required to load releases.");
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is unavailable for loading GitHub releases.");
  }

  const releases = [];

  for (let page = 1; page <= 5; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "User-Agent": "hagiscript-release-versioning"
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to load releases from GitHub API: HTTP ${response.status}`
      );
    }

    const pageReleases = await response.json();
    if (!Array.isArray(pageReleases)) {
      throw new Error("GitHub API returned an unexpected releases payload.");
    }

    releases.push(...pageReleases);

    if (pageReleases.length < 100) {
      break;
    }
  }

  return releases;
}

export async function resolveDevelopmentBaseVersion({
  packageVersion,
  explicitTagName,
  repository = process.env.GITHUB_REPOSITORY,
  githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  requireUnreleasedTag = false,
  fetchImpl = globalThis.fetch
}) {
  if (explicitTagName) {
    return extractStableVersionFromTag(explicitTagName);
  }

  const packageBaseVersion = parseStableVersion(packageVersion, "package version");

  if (repository && githubToken) {
    const releases = await fetchRepositoryReleases({
      repository,
      githubToken,
      fetchImpl
    });
    const releaseDraftVersion = selectNextUnreleasedReleaseVersion(releases);

    if (releaseDraftVersion) {
      return releaseDraftVersion;
    }

    const latestPublishedReleaseVersion =
      selectLatestPublishedReleaseVersion(releases);
    if (latestPublishedReleaseVersion) {
      return incrementPatchVersion(latestPublishedReleaseVersion);
    }
  }

  if (requireUnreleasedTag) {
    throw new Error(
      "Unable to resolve a development base version from GitHub release tags."
    );
  }

  return packageBaseVersion;
}
