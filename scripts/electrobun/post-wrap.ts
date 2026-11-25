import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

if (process.env.ELECTROBUN_OS === "macos" && process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH) {
  const bundlePath = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
  const plistPath = join(bundlePath, "Contents", "Info.plist");
  const micDescription =
    "Tapo Admin uses your microphone for two-way audio talkback to Tapo cameras.";

  if (existsSync(plistPath)) {
    const replaceProc = Bun.spawnSync(
      ["plutil", "-replace", "NSMicrophoneUsageDescription", "-string", micDescription, plistPath],
      { stdout: "inherit", stderr: "pipe" },
    );

    if (replaceProc.exitCode !== 0) {
      const insertProc = Bun.spawnSync(
        ["plutil", "-insert", "NSMicrophoneUsageDescription", "-string", micDescription, plistPath],
        { stdout: "inherit", stderr: "inherit" },
      );
      if (insertProc.exitCode !== 0) {
        throw new Error(
          `Failed to inject NSMicrophoneUsageDescription into ${plistPath} (exit ${insertProc.exitCode})`,
        );
      }
    }
  }

  const bundledFfmpeg = join(bundlePath, "Contents", "Resources", "app", "bin", "ffmpeg");
  if (existsSync(bundledFfmpeg)) {
    chmodSync(bundledFfmpeg, 0o755);
    const developerId = process.env.ELECTROBUN_DEVELOPER_ID;
    if (developerId) {
      const signProc = Bun.spawnSync(
        [
          "codesign",
          "--force",
          "--options",
          "runtime",
          "--timestamp",
          "--sign",
          developerId,
          bundledFfmpeg,
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      if (signProc.exitCode !== 0) {
        throw new Error(`Failed to codesign bundled ffmpeg (exit ${signProc.exitCode})`);
      }
    }
  }
}
