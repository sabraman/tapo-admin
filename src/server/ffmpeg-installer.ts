import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { tServer } from "../shared/i18n";
import type { FfmpegInstallState, ResolvedLanguage } from "../shared/types";

export const FFMPEG_STATIC_TAG = "b6.1.1";
export const DEFAULT_FFMPEG_BINARIES_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}`;

export function getFfmpegExeName(platform = process.platform): string {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export function getFfmpegAssetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin" && arch === "arm64") return "ffmpeg-darwin-arm64.gz";
  if (platform === "darwin" && arch === "x64") return "ffmpeg-darwin-x64.gz";
  if (platform === "win32" && arch === "x64") return "ffmpeg-win32-x64.gz";
  if (platform === "linux" && arch === "x64") return "ffmpeg-linux-x64.gz";
  if (platform === "linux" && arch === "arm64") return "ffmpeg-linux-arm64.gz";
  return null;
}

export function defaultVerifyFfmpegBinary(binaryPath: string): boolean {
  try {
    const proc = Bun.spawnSync([binaryPath, "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function downloadAndInstallFfmpeg(options: {
  installDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  verifyBinary?: (binaryPath: string) => boolean | Promise<boolean>;
  getLang?: () => ResolvedLanguage;
  onProgress?: (info: { bytesReceived: number; bytesTotal?: number; progress?: number }) => void;
}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const lang = options.getLang?.() ?? "en";
  const assetName = getFfmpegAssetName(platform, arch);
  if (!assetName) {
    throw new Error(
      tServer(lang, "ffmpeg_install_unsupported", { platform, arch }),
    );
  }

  const baseUrl = (
    options.baseUrl?.trim() ||
    process.env.FFMPEG_BINARIES_URL?.trim() ||
    DEFAULT_FFMPEG_BINARIES_BASE_URL
  ).replace(/\/+$/, "");
  const url = `${baseUrl}/${assetName}`;
  const fetchFn = options.fetchImpl ?? fetch;
  const verifyFn = options.verifyBinary ?? defaultVerifyFfmpegBinary;

  mkdirSync(options.installDir, { recursive: true, mode: 0o755 });
  const targetPath = resolve(join(options.installDir, getFfmpegExeName(platform)));
  const tmpExt = platform === "win32" ? ".exe" : "";
  const tmpPath = resolve(
    join(options.installDir, `.ffmpeg-${process.pid}-${Date.now()}.tmp${tmpExt}`),
  );

  try {
    const res = await fetchFn(url, {
      redirect: "follow",
      headers: { "User-Agent": "tapo-admin-ffmpeg-installer" },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }

    const totalRaw = Number(res.headers.get("content-length") ?? 0);
    const bytesTotal = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : undefined;

    let gzBytes: Uint8Array;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            chunks.push(value);
            received += value.byteLength;
            const progress =
              bytesTotal !== undefined
                ? Math.min(99, Math.round((received / bytesTotal) * 100))
                : undefined;
            options.onProgress?.({ bytesReceived: received, bytesTotal, progress });
          }
        }
      } finally {
        reader.releaseLock();
      }
      const totalBuf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      gzBytes = totalBuf;
    } else {
      const arr = new Uint8Array(await res.arrayBuffer());
      gzBytes = arr;
      options.onProgress?.({
        bytesReceived: arr.byteLength,
        bytesTotal: arr.byteLength,
        progress: 100,
      });
    }

    if (gzBytes.byteLength === 0) {
      throw new Error("Downloaded empty archive");
    }

    const rawBinary = gunzipSync(gzBytes);
    writeFileSync(tmpPath, rawBinary, { mode: 0o755 });
    if (platform !== "win32") {
      chmodSync(tmpPath, 0o755);
    }

    const valid = await verifyFn(tmpPath);
    if (!valid) {
      throw new Error("Binary verification failed");
    }

    renameSync(tmpPath, targetPath);
    if (platform !== "win32") {
      chmodSync(targetPath, 0o755);
    }
    return targetPath;
  } catch (err) {
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true });
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(tServer(lang, "ffmpeg_install_failed", { error: msg }));
  }
}

export interface FfmpegInstallerBridge {
  getState: () => FfmpegInstallState;
  install: () => Promise<FfmpegInstallState>;
}

export function createFfmpegInstaller(options: {
  installDir: string;
  resolveExisting: () => string | null;
  getLang?: () => ResolvedLanguage;
  onInstalled?: (binaryPath: string) => void;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  verifyBinary?: (binaryPath: string) => boolean | Promise<boolean>;
  platform?: NodeJS.Platform;
  arch?: string;
}): FfmpegInstallerBridge {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const supported = Boolean(getFfmpegAssetName(platform, arch));

  let state: FfmpegInstallState = {
    phase: "idle",
    available: Boolean(options.resolveExisting()),
    supported,
    binaryPath: options.resolveExisting() ?? undefined,
  };
  let inFlight: Promise<FfmpegInstallState> | null = null;

  const getState = (): FfmpegInstallState => {
    const existing = options.resolveExisting();
    if (existing && state.phase !== "downloading" && state.phase !== "verifying") {
      state = {
        phase: "ready",
        available: true,
        supported,
        binaryPath: existing,
        progress: 100,
      };
    } else if (!existing && state.phase === "ready") {
      state = {
        phase: "idle",
        available: false,
        supported,
      };
    }
    return { ...state };
  };

  const install = async (): Promise<FfmpegInstallState> => {
    const existing = options.resolveExisting();
    if (existing) {
      state = {
        phase: "ready",
        available: true,
        supported,
        binaryPath: existing,
        progress: 100,
      };
      return { ...state };
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      state = {
        phase: "downloading",
        available: false,
        supported,
        progress: 0,
        bytesReceived: 0,
      };
      try {
        const installedPath = await downloadAndInstallFfmpeg({
          installDir: options.installDir,
          platform,
          arch,
          baseUrl: options.baseUrl,
          fetchImpl: options.fetchImpl,
          verifyBinary: (tmp) => {
            state = {
              ...state,
              phase: "verifying",
              progress: 100,
            };
            return (options.verifyBinary ?? defaultVerifyFfmpegBinary)(tmp);
          },
          getLang: options.getLang,
          onProgress: (info) => {
            state = {
              ...state,
              phase: "downloading",
              bytesReceived: info.bytesReceived,
              bytesTotal: info.bytesTotal,
              progress: info.progress,
            };
          },
        });
        options.onInstalled?.(installedPath);
        state = {
          phase: "ready",
          available: true,
          supported,
          binaryPath: installedPath,
          progress: 100,
        };
      } catch (err) {
        state = {
          phase: "error",
          available: false,
          supported,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        inFlight = null;
      }
      return { ...state };
    })();

    return inFlight;
  };

  return { getState, install };
}
