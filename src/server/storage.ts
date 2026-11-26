import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { normalizeLanguagePreference } from "../shared/i18n";
import type {
  CameraOrientation,
  DashboardSettings,
  MediaItem,
  NetworkKind,
  Store,
} from "../shared/types";

export interface StoredSession {
  email: string;
  baseUrl: string;
  regionCode: string;
  token: string;
  refreshToken?: string;
  terminalUuid: string;
  terminalBound: boolean;
  savedAt: number;
}

export interface WorkspaceConfig {
  stores: Store[];
  storeMeta: Record<string, { address?: string; networkKind?: NetworkKind }>;
  roomOverrides: Record<string, string>;
  customNames: Record<string, string>;
  cameraOrientations: Record<string, CameraOrientation>;
  settings: DashboardSettings;
}

const DEFAULT_SETTINGS: DashboardSettings = {
  gridFps: 30,
  gridResolution: "VGA",
  gridTransport: "webcodecs",
  autoCycleSeconds: 0,
  language: "auto",
};

export class AppStorage {
  readonly dataDir: string;
  readonly mediaDir: string;
  readonly mediaIndexPath: string;
  readonly sessionPath: string;
  readonly terminalUuidPath: string;
  readonly workspacePath: string;

  constructor(rootDir: string, options?: { directDataDir?: boolean }) {
    this.dataDir = options?.directDataDir ? rootDir : join(rootDir, ".data");
    this.mediaDir = join(this.dataDir, "media");
    this.mediaIndexPath = join(this.mediaDir, "index.json");
    this.sessionPath = join(this.dataDir, "session.json");
    this.terminalUuidPath = join(this.dataDir, "terminal_uuid");
    this.workspacePath = join(this.dataDir, "workspace.json");
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.mediaDir, { recursive: true, mode: 0o755 });
  }

  private writeAtomic(filePath: string, content: string, mode = 0o600): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, { encoding: "utf8", mode });
    renameSync(tmp, filePath);
    chmodSync(filePath, mode);
  }

  getOrCreateTerminalUuid(): string {
    if (existsSync(this.terminalUuidPath)) {
      const val = readFileSync(this.terminalUuidPath, "utf8").trim();
      if (val) return val;
    }
    const created = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    this.writeAtomic(this.terminalUuidPath, `${created}\n`, 0o600);
    return created;
  }

  loadSession(): StoredSession | null {
    if (!existsSync(this.sessionPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.sessionPath, "utf8")) as Partial<StoredSession>;
      if (!parsed.token || !parsed.baseUrl || !parsed.terminalUuid) return null;
      return {
        email: parsed.email ?? "",
        baseUrl: parsed.baseUrl,
        regionCode: parsed.regionCode ?? "EU",
        token: parsed.token,
        refreshToken: parsed.refreshToken,
        terminalUuid: parsed.terminalUuid,
        terminalBound: parsed.terminalBound ?? true,
        savedAt: parsed.savedAt ?? Date.now(),
      };
    } catch {
      return null;
    }
  }

  saveSession(session: StoredSession): void {
    this.writeAtomic(this.sessionPath, JSON.stringify(session, null, 2), 0o600);
  }

  clearSession(): void {
    if (!existsSync(this.sessionPath)) return;
    this.writeAtomic(this.sessionPath, "{}", 0o600);
  }

  loadWorkspace(): WorkspaceConfig {
    const empty = (): WorkspaceConfig => ({
      stores: [],
      storeMeta: {},
      roomOverrides: {},
      customNames: {},
      cameraOrientations: {},
      settings: { ...DEFAULT_SETTINGS },
    });
    if (!existsSync(this.workspacePath)) {
      return empty();
    }
    try {
      const parsed = JSON.parse(readFileSync(this.workspacePath, "utf8")) as Partial<WorkspaceConfig>;
      // Drop legacy auto-seeded fake "Точка 1" / "Тестовая точка" so server-fetched Tapo rooms show cleanly.
      const stores = Array.isArray(parsed.stores)
        ? parsed.stores.filter((s) => !(s.name === "Точка 1" && s.address === "Тестовая точка"))
        : [];
      return {
        stores,
        storeMeta: parsed.storeMeta ?? {},
        roomOverrides: parsed.roomOverrides ?? {},
        customNames: parsed.customNames ?? {},
        cameraOrientations: parsed.cameraOrientations ?? {},
        settings: {
          ...DEFAULT_SETTINGS,
          ...(parsed.settings ?? {}),
          language: normalizeLanguagePreference(
            parsed.settings?.language ?? DEFAULT_SETTINGS.language,
          ),
        },
      };
    } catch {
      return empty();
    }
  }

  saveWorkspace(config: WorkspaceConfig): void {
    this.writeAtomic(this.workspacePath, JSON.stringify(config, null, 2), 0o644);
  }

  listMedia(): MediaItem[] {
    if (!existsSync(this.mediaIndexPath)) return [];
    try {
      const items = JSON.parse(readFileSync(this.mediaIndexPath, "utf8")) as MediaItem[];
      return Array.isArray(items)
        ? items.filter((item) => item && typeof item.filename === "string" && existsSync(join(this.mediaDir, basename(item.filename))))
        : [];
    } catch {
      return [];
    }
  }

  private saveMediaIndex(items: MediaItem[]): void {
    this.writeAtomic(this.mediaIndexPath, JSON.stringify(items, null, 2), 0o644);
  }

  saveMediaFile(
    meta: Omit<MediaItem, "id" | "filename" | "sizeBytes" | "createdAt">,
    ext: "jpg" | "mp4",
    data: Buffer,
  ): MediaItem {
    const createdAt = Date.now();
    const id = `m-${createdAt}-${crypto.randomUUID().slice(0, 6)}`;
    const safePrefix = meta.cameraName.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "_").replace(/^_+|_+$/g, "") || "cam";
    const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${safePrefix}-${stamp}-${id.slice(-6)}.${ext}`;
    const filePath = join(this.mediaDir, filename);
    writeFileSync(filePath, data, { mode: 0o644 });

    const item: MediaItem = {
      ...meta,
      id,
      filename,
      sizeBytes: data.length,
      createdAt,
    };
    const items = [item, ...this.listMedia()];
    this.saveMediaIndex(items);
    return item;
  }

  getMediaItem(id: string): { item: MediaItem; filePath: string } | null {
    const items = this.listMedia();
    const item = items.find((m) => m.id === id);
    if (!item) return null;
    const filePath = join(this.mediaDir, basename(item.filename));
    if (!existsSync(filePath)) return null;
    return { item, filePath };
  }

  deleteMediaItem(id: string): boolean {
    const items = this.listMedia();
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    const [removed] = items.splice(idx, 1);
    this.saveMediaIndex(items);
    if (removed) {
      const filePath = join(this.mediaDir, basename(removed.filename));
      try {
        rmSync(filePath, { force: true });
      } catch {
        // ignore missing file
      }
    }
    return true;
  }
}
