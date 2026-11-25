import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface StartTapoServerOptions {
  hostname?: string;
  port?: number;
  dataDir?: string;
  directDataDir?: boolean;
  certPath?: string;
  ffmpegPath?: string;
  staticDir?: string;
  devHtmlRoute?: unknown;
  development?: boolean;
  accessPassword?: string;
  debugEmulatorEnabled?: boolean;
  desktopApp?: boolean;
}

export interface RunningTapoServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: Bun.Server<any>;
  port: number;
  hostname: string;
  url: string;
  stop: () => void;
}

const DEFAULT_ROOT_DIR = resolve(import.meta.dir, "..", "..");

function isExistingFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

/**
 * Resolves the ffmpeg binary across explicit configuration, bundled desktop/app locations,
 * system PATH, and common macOS/Linux install prefixes.
 */
export function findFfmpegBinary(preferredPath?: string): string | null {
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  const tryExplicit = (candidate: string | undefined): string | null => {
    const trimmed = candidate?.trim();
    if (!trimmed) return null;
    if (isExistingFile(trimmed)) return resolve(trimmed);
    const resolved = Bun.which(trimmed);
    if (resolved && isExistingFile(resolved)) return resolved;
    return null;
  };

  const fromPreferred = tryExplicit(preferredPath);
  if (fromPreferred) return fromPreferred;

  const fromEnv = tryExplicit(process.env.FFMPEG_PATH);
  if (fromEnv) return fromEnv;

  const execDir = dirname(process.execPath);
  const bundledCandidates = [
    join(execDir, exeName),
    join(execDir, "bin", exeName),
    join(execDir, "..", "Resources", exeName),
    join(execDir, "..", "Resources", "app", exeName),
    join(execDir, "..", "Resources", "app", "bin", exeName),
    join(process.cwd(), exeName),
    join(process.cwd(), "bin", exeName),
    join(DEFAULT_ROOT_DIR, "bin", exeName),
  ];

  for (const candidate of bundledCandidates) {
    if (isExistingFile(candidate)) return resolve(candidate);
  }

  const fromWhich = Bun.which(exeName) ?? Bun.which("ffmpeg");
  if (fromWhich && isExistingFile(fromWhich)) return fromWhich;

  if (process.platform !== "win32") {
    for (const sysPath of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
      if (isExistingFile(sysPath)) return sysPath;
    }
  }

  return null;
}

/**
 * Reads runtime server defaults from environment variables and standard workspace paths.
 */
export function resolveRuntimeServerConfig(): StartTapoServerOptions {
  const hostname = process.env.HOST?.trim() || "127.0.0.1";
  const rawPort = process.env.PORT;
  const parsedPort = rawPort !== undefined && rawPort.trim() !== "" ? Number(rawPort) : 3456;
  const port = Number.isFinite(parsedPort) && parsedPort >= 0 ? parsedPort : 3456;

  const envDataDir = process.env.TAPO_DATA_DIR?.trim();
  const dataDir = envDataDir ? resolve(envDataDir) : DEFAULT_ROOT_DIR;
  const directDataDir = Boolean(envDataDir);

  const envCertPath = process.env.TAPO_CERT_PATH?.trim();
  const certPath = envCertPath
    ? resolve(envCertPath)
    : join(DEFAULT_ROOT_DIR, "certs", "tapo-cloud-roots.pem");

  const ffmpegPath = findFfmpegBinary(process.env.FFMPEG_PATH?.trim() || undefined) ?? undefined;
  const envStaticDir = process.env.TAPO_STATIC_DIR?.trim();
  const staticDir = envStaticDir ? resolve(envStaticDir) : undefined;

  const rawPassword = process.env.TAPO_ACCESS_PASSWORD;
  const accessPassword = rawPassword && rawPassword.trim().length > 0 ? rawPassword : undefined;

  const debugEmulatorEnabled = parseBoolEnv(process.env.TAPO_DEBUG_EMULATOR) ?? false;

  return {
    hostname,
    port,
    dataDir,
    directDataDir,
    certPath,
    ffmpegPath,
    staticDir,
    accessPassword,
    debugEmulatorEnabled,
  };
}
