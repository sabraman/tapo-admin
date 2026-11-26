import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  defaultVerifyFfmpegBinary,
  downloadAndInstallFfmpeg,
  getFfmpegExeName,
} from "../../src/server/ffmpeg-installer";

const rootDir = join(import.meta.dir, "..", "..");

const buildProc = Bun.spawnSync([process.execPath, "run", join(rootDir, "scripts", "build-client.ts")], {
  cwd: rootDir,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

if (buildProc.exitCode !== 0) {
  throw new Error(`Client build failed with exit code ${buildProc.exitCode}`);
}

const bundledBinDir = join(rootDir, "dist", "bin");
mkdirSync(bundledBinDir, { recursive: true });
const bundledFfmpegPath = join(bundledBinDir, getFfmpegExeName());
if (process.env.TAPO_SKIP_FFMPEG_BUNDLE !== "1") {
  const alreadyValid = existsSync(bundledFfmpegPath) && defaultVerifyFfmpegBinary(bundledFfmpegPath);
  if (!alreadyValid) {
    console.log(`[pre-build] Staging static ffmpeg into ${bundledFfmpegPath}...`);
    await downloadAndInstallFfmpeg({ installDir: bundledBinDir });
  }
}

const requiredAssets = [
  "assets/icon.iconset",
  "assets/icon.ico",
  "assets/tray-Template.png",
  "assets/tray.ico",
  "certs/tapo-cloud-roots.pem",
];

for (const relPath of requiredAssets) {
  const fullPath = join(rootDir, relPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing required Electrobun asset: ${relPath}`);
  }
}
