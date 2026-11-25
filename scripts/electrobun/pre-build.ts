import { existsSync } from "node:fs";
import { join } from "node:path";

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
