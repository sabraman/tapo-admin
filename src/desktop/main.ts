import { existsSync } from "node:fs";
import { join } from "node:path";
import Electrobun, {
  ApplicationMenu,
  BrowserWindow,
  PATHS,
  Tray,
  Utils,
} from "electrobun/main";
import { startTapoServer } from "../server/app";
import { resolveRuntimeServerConfig } from "../server/config";
import { createDesktopUpdaterBridge } from "./updater";

function resolveExistingPath(candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return fallback;
}

const certPath = resolveExistingPath(
  [
    join(PATHS.RESOURCES_FOLDER, "app", "certs", "tapo-cloud-roots.pem"),
    join(process.cwd(), "certs", "tapo-cloud-roots.pem"),
  ],
  join(process.cwd(), "certs", "tapo-cloud-roots.pem"),
);

const staticDir = resolveExistingPath(
  [join(PATHS.VIEWS_FOLDER, "client"), join(process.cwd(), "dist", "client")],
  join(PATHS.VIEWS_FOLDER, "client"),
);

const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const bundledFfmpegPath = join(PATHS.RESOURCES_FOLDER, "app", "bin", ffmpegName);
const ffmpegPath = existsSync(bundledFfmpegPath) ? bundledFfmpegPath : undefined;

const runtimeConfig = resolveRuntimeServerConfig();
const desktopUpdater = createDesktopUpdaterBridge();

const running = startTapoServer({
  hostname: "127.0.0.1",
  port: 0,
  dataDir: Utils.paths.userData,
  directDataDir: true,
  certPath,
  staticDir,
  ffmpegPath,
  development: false,
  desktopApp: true,
  debugEmulatorEnabled: Boolean(runtimeConfig.debugEmulatorEnabled),
  updater: desktopUpdater,
});

ApplicationMenu.setApplicationMenu([
  {
    label: "Tapo Admin",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
  },
]);

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "Tapo Admin",
    url: running.url,
    frame: {
      width: 1360,
      height: 860,
    },
    titleBarStyle: "default",
    renderer: "native",
  });

  win.on("close", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  return win;
}

let mainWindow: BrowserWindow | null = createMainWindow();

const trayPngPath = resolveExistingPath(
  [
    join(PATHS.RESOURCES_FOLDER, "app", "assets", "tray-Template.png"),
    join(process.cwd(), "assets", "tray-Template.png"),
  ],
  join(process.cwd(), "assets", "tray-Template.png"),
);
const trayIcoPath = resolveExistingPath(
  [
    join(PATHS.RESOURCES_FOLDER, "app", "assets", "tray.ico"),
    join(process.cwd(), "assets", "tray.ico"),
  ],
  join(process.cwd(), "assets", "tray.ico"),
);

const tray = new Tray({
  title: "Tapo Admin",
  image: process.platform === "win32" ? trayIcoPath : trayPngPath,
  template: process.platform !== "win32",
  width: 18,
  height: 18,
});

tray.setMenu([
  { type: "normal", label: "Show Window", action: "show-window" },
  { type: "normal", label: "Check for Updates", action: "check-updates" },
  { type: "separator" },
  { type: "normal", label: "Quit", action: "quit" },
]);

let stopped = false;
function stopServerOnce(): void {
  if (stopped) return;
  stopped = true;
  try {
    running.stop();
  } catch {
    // ignore shutdown cleanup errors
  }
}

tray.on("tray-clicked", (event: unknown) => {
  const action =
    typeof event === "object" &&
    event !== null &&
    "data" in event &&
    typeof (event as { data?: { action?: unknown } }).data?.action === "string"
      ? (event as { data: { action: string } }).data.action
      : undefined;
  if (action === "quit") {
    stopServerOnce();
    Utils.quit();
    return;
  }

  if (action === "check-updates") {
    void desktopUpdater.checkForUpdate().then((res) => {
      if (res.phase === "available" || res.phase === "ready") {
        Utils.showNotification({
          title: "Tapo Admin",
          body: `Update v${res.latestVersion ?? ""} is available in System → Account.`,
        });
      }
    });
  }

  if (!mainWindow) {
    mainWindow = createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.activate();
  }
});

Electrobun.events.on("before-quit", () => {
  stopServerOnce();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopServerOnce();
    Utils.quit();
  });
}
