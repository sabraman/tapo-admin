import { Updater, type UpdateStatusEntry } from "electrobun/main";
import {
  compareSemver,
  createFallbackUpdater,
  getDefaultReleaseUrl,
  getPackageVersion,
  type AppUpdaterBridge,
} from "../server/updater";
import type { AppUpdateState } from "../shared/types";

function isDownloadStatus(status: string): boolean {
  return (
    status === "downloading" ||
    status === "download-starting" ||
    status === "checking-local-tar" ||
    status === "local-tar-found" ||
    status === "local-tar-missing" ||
    status === "fetching-patch" ||
    status === "patch-found" ||
    status === "patch-not-found" ||
    status === "downloading-patch" ||
    status === "applying-patch" ||
    status === "patch-applied" ||
    status === "patch-failed" ||
    status === "extracting-version" ||
    status === "patch-chain-complete" ||
    status === "downloading-full-bundle" ||
    status === "download-progress" ||
    status === "decompressing"
  );
}

function isApplyingStatus(status: string): boolean {
  return (
    status === "applying" ||
    status === "extracting" ||
    status === "replacing-app" ||
    status === "launching-new-version"
  );
}

export function createDesktopUpdaterBridge(): AppUpdaterBridge {
  const currentVersion = getPackageVersion();
  const releaseUrl = getDefaultReleaseUrl();
  const fallback = createFallbackUpdater({ currentVersion });

  let state: AppUpdateState = {
    currentVersion,
    phase: "idle",
    canAutoUpdate: false,
    releaseUrl,
  };
  let checkInFlight: Promise<AppUpdateState> | null = null;
  let applyInFlight = false;

  try {
    Updater.onStatusChange((entry: UpdateStatusEntry) => {
      const progress =
        typeof entry.details?.progress === "number" ? entry.details.progress : state.progress;

      if (entry.status === "checking") {
        state = { ...state, phase: "checking", message: entry.message, error: undefined };
      } else if (isDownloadStatus(entry.status)) {
        state = {
          ...state,
          phase: "downloading",
          message: entry.message,
          progress,
          error: undefined,
        };
      } else if (entry.status === "download-complete") {
        state = {
          ...state,
          phase: "ready",
          message: entry.message,
          progress: 100,
          error: undefined,
        };
      } else if (isApplyingStatus(entry.status)) {
        state = {
          ...state,
          phase: "applying",
          message: entry.message,
          progress: 100,
          error: undefined,
        };
      } else if (entry.status === "error") {
        applyInFlight = false;
        state = {
          ...state,
          phase: "error",
          message: entry.message,
          error: entry.details?.errorMessage ?? entry.message,
        };
      }
    });
  } catch {
    // Native updater unavailable outside packaged Electrobun runtime; fallback remains active.
  }

  const checkForUpdate = async (): Promise<AppUpdateState> => {
    if (checkInFlight) return checkInFlight;

    checkInFlight = (async () => {
      state = { ...state, phase: "checking", error: undefined };
      try {
        const local = await Updater.getLocalInfo();
        const localVersion = local.version?.trim() || currentVersion;
        const canNativeCheck =
          Boolean(local.baseUrl?.trim()) &&
          local.channel !== "dev" &&
          local.updateAuthority !== "none";

        if (!canNativeCheck) {
          const fb = await fallback.checkForUpdate();
          state = { ...fb, currentVersion: localVersion, canAutoUpdate: false };
          return state;
        }

        const info = await Updater.checkForUpdate();
        if (info.error) {
          // If the native manifest is missing (e.g. 404 before first release), check GitHub Releases cleanly.
          const fb = await fallback.checkForUpdate();
          if (fb.phase !== "error") {
            state = { ...fb, currentVersion: localVersion, canAutoUpdate: false };
            return state;
          }
          throw new Error(info.error);
        }

        const latestVersion = info.version?.trim() || localVersion;
        const newerBySemver = info.version ? compareSemver(latestVersion, localVersion) > 0 : false;
        const updateAvailable = Boolean(info.updateAvailable) && (newerBySemver || !info.version);

        state = {
          currentVersion: localVersion,
          phase: info.updateReady ? "ready" : updateAvailable ? "available" : "up-to-date",
          canAutoUpdate: true,
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
        checkInFlight = null;
      }
    })();

    return checkInFlight;
  };

  const applyUpdate = async (): Promise<AppUpdateState> => {
    if (applyInFlight) {
      return { ...state };
    }
    const local = await Updater.getLocalInfo().catch(() => null);
    if (!local?.baseUrl?.trim() || local.channel === "dev" || !state.canAutoUpdate) {
      throw new Error("Auto-update is only available in packaged release builds");
    }

    applyInFlight = true;
    state = {
      ...state,
      phase: "downloading",
      progress: 0,
      error: undefined,
    };

    void (async () => {
      try {
        if (!Updater.updateInfo().updateReady) {
          await Updater.downloadUpdate();
        }
        if (!Updater.updateInfo().updateReady) {
          throw new Error(Updater.updateInfo().error || "Downloaded update is not ready");
        }
        state = { ...state, phase: "applying", progress: 100, error: undefined };
        setTimeout(() => {
          void Updater.applyUpdate().catch((err) => {
            applyInFlight = false;
            state = {
              ...state,
              phase: "error",
              error: err instanceof Error ? err.message : String(err),
            };
          });
        }, 150);
      } catch (err) {
        applyInFlight = false;
        state = {
          ...state,
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    return { ...state };
  };

  return {
    getState: () => ({ ...state }),
    checkForUpdate,
    applyUpdate,
  };
}
