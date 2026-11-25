import pkg from "../../package.json" with { type: "json" };
import type { AppUpdateState } from "../shared/types";

export const DEFAULT_GITHUB_REPO = "sabraman/tapo-admin";

export interface AppUpdaterBridge {
  getState: () => AppUpdateState;
  checkForUpdate: () => Promise<AppUpdateState>;
  applyUpdate?: () => Promise<AppUpdateState>;
}

export function getPackageVersion(): string {
  return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.1.0";
}

export function normalizeReleaseRepo(raw?: string): string {
  const cleaned = raw?.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (cleaned && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(cleaned)) {
    return cleaned;
  }
  return DEFAULT_GITHUB_REPO;
}

export function getDefaultReleaseUrl(repo = DEFAULT_GITHUB_REPO): string {
  return `https://github.com/${normalizeReleaseRepo(repo)}/releases/latest`;
}

function parseSemver(version: string): { core: [number, number, number]; pre: string[] } | null {
  const cleaned = version.trim().replace(/^v/i, "");
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/**
 * Compares two semver strings (`a` vs `b`), returning `1` if `a > b`, `-1` if `a < b`, or `0` if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    const na = a.trim().replace(/^v/i, "");
    const nb = b.trim().replace(/^v/i, "");
    return na === nb ? 0 : na > nb ? 1 : -1;
  }

  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! > pb.core[i]!) return 1;
    if (pa.core[i]! < pb.core[i]!) return -1;
  }

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const maxLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < maxLen; i++) {
    const segA = pa.pre[i];
    const segB = pb.pre[i];
    if (segA === undefined) return -1;
    if (segB === undefined) return 1;
    const numA = /^\d+$/.test(segA) ? Number(segA) : null;
    const numB = /^\d+$/.test(segB) ? Number(segB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA > numB ? 1 : -1;
    } else if (numA !== null) {
      return -1;
    } else if (numB !== null) {
      return 1;
    } else if (segA !== segB) {
      return segA > segB ? 1 : -1;
    }
  }
  return 0;
}

export function createFallbackUpdater(options?: {
  currentVersion?: string;
  releaseRepo?: string;
  releasesApiUrl?: string;
  fetchImpl?: typeof fetch;
}): AppUpdaterBridge {
  const currentVersion = options?.currentVersion?.trim() || getPackageVersion();
  const repo = normalizeReleaseRepo(options?.releaseRepo ?? process.env.TAPO_RELEASES_REPO);
  const defaultReleaseUrl = getDefaultReleaseUrl(repo);
  const apiUrl =
    options?.releasesApiUrl?.trim() ||
    process.env.TAPO_RELEASES_API_URL?.trim() ||
    `https://api.github.com/repos/${repo}/releases/latest`;
  const fetchFn = options?.fetchImpl ?? fetch;

  let state: AppUpdateState = {
    currentVersion,
    phase: "idle",
    canAutoUpdate: false,
    releaseUrl: defaultReleaseUrl,
  };
  let inFlight: Promise<AppUpdateState> | null = null;

  const checkForUpdate = async (): Promise<AppUpdateState> => {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      state = {
        ...state,
        phase: "checking",
        error: undefined,
      };
      try {
        const res = await fetchFn(apiUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `tapo-admin/${currentVersion}`,
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (res.status === 404) {
          state = {
            currentVersion,
            phase: "up-to-date",
            canAutoUpdate: false,
            latestVersion: currentVersion,
            releaseUrl: defaultReleaseUrl,
            checkedAt: Date.now(),
          };
          return state;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = (await res.json()) as {
          tag_name?: string;
          html_url?: string;
        };
        const rawTag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
        const latestVersion = rawTag.replace(/^v/i, "") || currentVersion;
        const releaseUrl =
          typeof data.html_url === "string" && data.html_url.trim()
            ? data.html_url.trim()
            : defaultReleaseUrl;
        const hasNewer = rawTag ? compareSemver(latestVersion, currentVersion) > 0 : false;

        state = {
          currentVersion,
          phase: hasNewer ? "available" : "up-to-date",
          canAutoUpdate: false,
          latestVersion,
          releaseUrl,
          checkedAt: Date.now(),
        };
        return state;
      } catch (err) {
        state = {
          ...state,
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
          checkedAt: Date.now(),
        };
        return state;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  return {
    getState: () => ({ ...state }),
    checkForUpdate,
  };
}
