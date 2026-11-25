import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { normalizeLanguagePreference, resolveLanguage, tServer } from "../shared/i18n";
import type {
  AuthState,
  CameraMeta,
  DashboardBootstrap,
  DashboardSettings,
  ResolvedLanguage,
  RuntimeCapabilities,
  Store,
} from "../shared/types";
import { createAccessGuard } from "./auth-guard";
import {
  findFfmpegBinary,
  resolveRuntimeServerConfig,
  type RunningTapoServer,
  type StartTapoServerOptions,
} from "./config";
import { streamSdRecordingMp4 } from "./playback";
import { AppStorage, type StoredSession } from "./storage";
import { StreamManager } from "./stream-manager";
import { type CloudFamily, TapoCloudClient, TapoCloudError } from "./tapo-cloud";
import { createFallbackUpdater, getPackageVersion } from "./updater";

export interface WsStreamData {
  kind: "fmp4" | "ts" | "audio" | "talk";
  deviceId: string;
  quality?: "grid" | "hd";
  unsub?: () => void;
  talkHandle?: { sendAlaw: (alaw: Uint8Array) => void; close: () => void };
}

function jsonOk(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(data, { status, headers });
}

function jsonErr(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return Response.json({ error: message, ...extra }, { status });
}

function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const asciiFallback =
    filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "media";
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isHashedAssetPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("assets/") || normalized.startsWith("_bun/")) {
    return /\.(js|mjs|css|woff2?|png|svg|jpg|jpeg|webp|wasm|map)$/i.test(normalized);
  }
  return /[.-][0-9a-f]{6,}\.(js|mjs|css|woff2?|png|svg|jpg|jpeg|webp|wasm)$/i.test(normalized);
}

export function startTapoServer(options: StartTapoServerOptions = {}): RunningTapoServer {
  const defaults = resolveRuntimeServerConfig();
  const hostname = options.hostname ?? defaults.hostname ?? "127.0.0.1";
  const port = options.port ?? defaults.port ?? 3456;
  const dataDir = options.dataDir ?? defaults.dataDir ?? resolve(import.meta.dir, "..", "..");
  const directDataDir =
    options.directDataDir ??
    (options.dataDir !== undefined ? false : defaults.directDataDir ?? false);
  const certPath = options.certPath ?? defaults.certPath!;
  const resolvedFfmpegPath =
    options.ffmpegPath !== undefined
      ? findFfmpegBinary(options.ffmpegPath)
      : defaults.ffmpegPath
        ? findFfmpegBinary(defaults.ffmpegPath)
        : findFfmpegBinary();
  const staticDir = options.staticDir ?? defaults.staticDir;
  const resolvedStaticDir = staticDir ? resolve(staticDir) : "";
  const indexHtmlPath = resolvedStaticDir ? join(resolvedStaticDir, "index.html") : "";
  const hasStaticDir = Boolean(resolvedStaticDir && existsSync(indexHtmlPath));
  const accessPassword =
    options.accessPassword !== undefined ? options.accessPassword : defaults.accessPassword;
  const debugEmulatorEnabled =
    options.debugEmulatorEnabled ?? defaults.debugEmulatorEnabled ?? false;
  const desktopApp = options.desktopApp ?? false;
  const appVersion = options.appVersion?.trim() || getPackageVersion();
  const updater =
    options.updater ??
    createFallbackUpdater({
      currentVersion: appVersion,
    });

  const accessGuard = createAccessGuard(accessPassword);
  const storage = new AppStorage(dataDir, { directDataDir });

  let session: StoredSession | null = storage.loadSession();
  const workspace = storage.loadWorkspace();
  let cameras: CameraMeta[] = [];
  let cloudFamilies: CloudFamily[] = [];

  // Volatile in-memory state only while a login/MFA flow is active or to refresh
  // expired tokens without persisting the plaintext password on disk.
  let volatileCreds: { email: string; password: string } | null = null;
  let pendingMfa: Extract<AuthState, { status: "mfa_required" }> | null = null;

  const requestLangStorage = new AsyncLocalStorage<ResolvedLanguage>();
  let lastAutoLocaleHint: string | null = process.env.LANG || process.env.LC_ALL || null;

  const getServerLang = (): ResolvedLanguage => {
    const active = requestLangStorage.getStore();
    if (active) return active;
    return resolveLanguage(workspace.settings.language, lastAutoLocaleHint);
  };

  const resolveRequestLang = (req: Request): ResolvedLanguage => {
    const acceptLanguage = req.headers.get("accept-language");
    if (acceptLanguage) {
      lastAutoLocaleHint = acceptLanguage;
    }
    const headerLang = req.headers.get("x-tapo-lang")?.trim().toLowerCase();
    if (headerLang === "en" || headerLang === "ru") {
      return headerLang;
    }
    if (workspace.settings.language === "en" || workspace.settings.language === "ru") {
      return workspace.settings.language;
    }
    return resolveLanguage("auto", acceptLanguage ?? lastAutoLocaleHint);
  };

  const client = new TapoCloudClient(certPath, getServerLang);

  const getCreds = () =>
    session ? { baseUrl: session.baseUrl, token: session.token } : null;

  const getSettings = (): DashboardSettings => workspace.settings;

  const capabilities: RuntimeCapabilities = {
    ffmpegAvailable: Boolean(resolvedFfmpegPath),
    debugEmulatorEnabled,
    desktopApp,
    appVersion,
  };

  async function handleAuthExpired(): Promise<boolean> {
    if (!volatileCreds || !session) return false;
    try {
      const out = await client.login(
        volatileCreds.email,
        volatileCreds.password,
        session.terminalUuid,
      );
      if (out.kind === "authenticated" && out.token) {
        session = {
          ...session,
          baseUrl: out.baseUrl,
          token: out.token,
          refreshToken: out.refreshToken,
          regionCode: out.regionCode ?? session.regionCode,
          savedAt: Date.now(),
        };
        storage.saveSession(session);
        return true;
      }
    } catch {
      // caller falls back to unauthenticated state
    }
    return false;
  }

  const streams = new StreamManager(
    client,
    getCreds,
    getSettings,
    handleAuthExpired,
    {
      ffmpegPath: resolvedFfmpegPath,
      getLang: getServerLang,
    },
  );

  function currentAuthState(): AuthState {
    if (pendingMfa) return pendingMfa;
    if (session) {
      return {
        status: "authenticated",
        email: session.email,
        baseUrl: session.baseUrl,
        regionCode: session.regionCode,
        terminalBound: session.terminalBound,
        savedAt: session.savedAt,
      };
    }
    return { status: "unauthenticated" };
  }

  function enrichedCameras(): CameraMeta[] {
    return cameras.map((c) => ({
      ...c,
      customName: workspace.customNames[c.deviceId],
    }));
  }

  function buildStores(): Store[] {
    const result: Store[] = [];
    const multipleNamedFamilies = cloudFamilies.filter((f) => f.name.length > 0).length > 1;

    for (const fam of cloudFamilies) {
      const validRooms = fam.rooms.filter((r) => r.id !== "other");
      for (const room of validRooms) {
        const id = `${fam.id}:${room.id}`;
        const meta = workspace.storeMeta[id];
        const displayName =
          fam.name && (multipleNamedFamilies || !fam.isDefault)
            ? `${fam.name} · ${room.name}`
            : room.name;
        result.push({
          id,
          name: displayName,
          address: meta?.address ?? "",
          networkKind: meta?.networkKind ?? "wired",
          cameraIds: [],
          createdAt: 0,
          familyId: fam.id,
          roomId: room.id,
          source: "cloud",
        });
      }

      const hasOtherCam = cameras.some(
        (c) => (c.familyId ?? "default") === fam.id && (!c.roomId || c.roomId === "other"),
      );
      if (fam.name && (validRooms.length === 0 || hasOtherCam)) {
        const id = `${fam.id}:other`;
        const meta = workspace.storeMeta[id];
        result.push({
          id,
          name: fam.name,
          address: meta?.address ?? "",
          networkKind: meta?.networkKind ?? "wired",
          cameraIds: [],
          createdAt: 0,
          familyId: fam.id,
          roomId: "other",
          source: "cloud",
        });
      }
    }

    const byId = new Map<string, Store>();
    for (const s of result) byId.set(s.id, s);

    for (const local of workspace.stores) {
      if (!byId.has(local.id)) {
        const copy: Store = { ...local, cameraIds: [], source: "local" };
        result.push(copy);
        byId.set(copy.id, copy);
      }
    }

    for (const cam of cameras) {
      const cloudStoreId = `${cam.familyId ?? "default"}:${cam.roomId ?? "other"}`;
      const hasOverride = Object.prototype.hasOwnProperty.call(
        workspace.roomOverrides,
        cam.deviceId,
      );
      const targetId = hasOverride ? workspace.roomOverrides[cam.deviceId] : cloudStoreId;
      if (!targetId) continue;
      const target = byId.get(targetId);
      if (target) {
        target.cameraIds.push(cam.deviceId);
      }
    }

    for (const local of workspace.stores) {
      const target = byId.get(local.id);
      if (!target) continue;
      for (const cid of local.cameraIds) {
        if (
          !Object.prototype.hasOwnProperty.call(workspace.roomOverrides, cid) &&
          cameras.some((c) => c.deviceId === cid) &&
          !result.some((s) => s.cameraIds.includes(cid))
        ) {
          target.cameraIds.push(cid);
        }
      }
    }

    return result;
  }

  function storeNameForCamera(deviceId: string): string | undefined {
    return buildStores().find((s) => s.cameraIds.includes(deviceId))?.name;
  }

  function findCamera(id: string): CameraMeta | undefined {
    return enrichedCameras().find((c) => c.deviceId === id);
  }

  async function refreshCameraList(): Promise<CameraMeta[]> {
    if (!session) return [];
    try {
      const res = await client.listCamerasAndFamilies(
        session.baseUrl,
        session.token,
        session.terminalUuid,
      );
      cameras = res.cameras;
      cloudFamilies = res.families;
    } catch (err) {
      if (err instanceof TapoCloudError && err.isAuthError) {
        const ok = await handleAuthExpired();
        if (ok && session) {
          const res = await client.listCamerasAndFamilies(
            session.baseUrl,
            session.token,
            session.terminalUuid,
          );
          cameras = res.cameras;
          cloudFamilies = res.families;
        } else {
          session = null;
          storage.clearSession();
          cameras = [];
          cloudFamilies = [];
          streams.syncCameras([]);
          throw err;
        }
      } else {
        throw err;
      }
    }

    streams.syncCameras(enrichedCameras());
    streams.pushLocalizedLog("info", "log_cameras_refreshed", { count: cameras.length });
    return enrichedCameras();
  }

  if (session) {
    refreshCameraList().catch((err) => {
      streams.pushLocalizedLog("warn", "log_startup_cameras_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  function serveStaticAsset(pathname: string, reqLang: ResolvedLanguage): Response {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return jsonErr(tServer(reqLang, "not_found"), 404);
    }

    const relPath = decodedPath.replace(/^\/+/, "");
    const candidate = relPath === "" ? indexHtmlPath : resolve(resolvedStaticDir, relPath);

    if (
      candidate !== resolvedStaticDir &&
      !candidate.startsWith(`${resolvedStaticDir}${sep}`)
    ) {
      return jsonErr(tServer(reqLang, "not_found"), 404);
    }

    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        const isIndex = candidate === indexHtmlPath;
        const cacheControl = isIndex
          ? "no-cache"
          : isHashedAssetPath(relPath)
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600";
        return new Response(Bun.file(candidate), {
          headers: { "Cache-Control": cacheControl },
        });
      }
    } catch {
      // fall through to SPA index fallback
    }

    return new Response(Bun.file(indexHtmlPath), {
      headers: { "Cache-Control": "no-cache" },
    });
  }

  const serveOptions: Parameters<typeof Bun.serve<WsStreamData>>[0] = {
    hostname,
    port,
    idleTimeout: 120,
    development: options.development ?? false,
    ...(options.devHtmlRoute !== undefined
      ? { routes: { "/": options.devHtmlRoute as never } }
      : {}),
    async fetch(req, srv) {
      const reqLang = resolveRequestLang(req);
      return await requestLangStorage.run(reqLang, async () => {
        const url = new URL(req.url);
        const { pathname, searchParams } = url;

        if (pathname.startsWith("/ws/")) {
          if (!accessGuard.isRequestAuthorized(req)) {
            return jsonErr(tServer(reqLang, "access_locked"), 401, { code: "ACCESS_LOCKED" });
          }

          const wsFmp4Match = pathname.match(/^\/ws\/fmp4\/([^/]+)$/);
          if (wsFmp4Match) {
            const deviceId = decodeURIComponent(wsFmp4Match[1]!);
            if (!findCamera(deviceId)) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const upgraded = srv.upgrade(req, { data: { kind: "fmp4", deviceId } });
            if (upgraded) return undefined;
            return jsonErr(tServer(reqLang, "ws_upgrade_failed"), 400);
          }

          const wsTsMatch = pathname.match(/^\/ws\/ts\/([^/]+)$/);
          if (wsTsMatch) {
            const deviceId = decodeURIComponent(wsTsMatch[1]!);
            if (!findCamera(deviceId)) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const quality = searchParams.get("quality") === "hd" ? "hd" : "grid";
            const upgraded = srv.upgrade(req, { data: { kind: "ts", deviceId, quality } });
            if (upgraded) return undefined;
            return jsonErr(tServer(reqLang, "ws_upgrade_failed"), 400);
          }

          const wsAudioMatch = pathname.match(/^\/ws\/audio\/([^/]+)$/);
          if (wsAudioMatch) {
            const deviceId = decodeURIComponent(wsAudioMatch[1]!);
            if (!findCamera(deviceId)) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const upgraded = srv.upgrade(req, { data: { kind: "audio", deviceId } });
            if (upgraded) return undefined;
            return jsonErr(tServer(reqLang, "ws_upgrade_failed"), 400);
          }

          const wsTalkMatch = pathname.match(/^\/ws\/talk\/([^/]+)$/);
          if (wsTalkMatch) {
            const deviceId = decodeURIComponent(wsTalkMatch[1]!);
            if (!findCamera(deviceId)) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const upgraded = srv.upgrade(req, { data: { kind: "talk", deviceId } });
            if (upgraded) return undefined;
            return jsonErr(tServer(reqLang, "ws_upgrade_failed"), 400);
          }

          return jsonErr(tServer(reqLang, "not_found"), 404);
        }

        try {
          if (pathname === "/api/health" && req.method === "GET") {
            return jsonOk({ ok: true });
          }

          if (pathname === "/api/access/unlock" && req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as { password?: string };
            if (!accessGuard.required) {
              return jsonOk({ unlocked: true });
            }
            if (!accessGuard.verifyPassword(String(body.password ?? ""))) {
              return jsonErr(tServer(reqLang, "access_invalid_password"), 401, {
                code: "INVALID_PASSWORD",
              });
            }
            return jsonOk({ unlocked: true }, 200, {
              "Set-Cookie": accessGuard.issueCookieHeader(req),
            });
          }

          if (pathname === "/api/access/lock" && req.method === "POST") {
            return jsonOk({ unlocked: false }, 200, {
              "Set-Cookie": accessGuard.clearCookieHeader(req),
            });
          }

          if (pathname === "/api/bootstrap" && req.method === "GET") {
            const accessRequired = accessGuard.required;
            const accessUnlocked = accessGuard.isRequestAuthorized(req);

            if (!accessUnlocked) {
              const currentUpdate = updater.getState();
              const lockedBootstrap: DashboardBootstrap = {
                accessRequired,
                accessUnlocked: false,
                auth: { status: "unauthenticated" },
                cameras: [],
                stores: [],
                telemetry: {},
                settings: {
                  gridFps: 30,
                  gridResolution: "VGA",
                  gridTransport: "webcodecs",
                  autoCycleSeconds: 0,
                  language: workspace.settings.language,
                },
                logs: [],
                media: [],
                mediaDir: "",
                capabilities,
                updateState: {
                  currentVersion: currentUpdate.currentVersion,
                  phase: "idle",
                  canAutoUpdate: currentUpdate.canAutoUpdate,
                  releaseUrl: currentUpdate.releaseUrl,
                },
              };
              return jsonOk(lockedBootstrap);
            }

            if (session && cameras.length === 0) {
              await refreshCameraList().catch(() => {});
            }

            const bootstrap: DashboardBootstrap = {
              accessRequired,
              accessUnlocked: true,
              auth: currentAuthState(),
              cameras: enrichedCameras(),
              stores: buildStores(),
              telemetry: streams.getAllTelemetry(),
              settings: workspace.settings,
              logs: streams.getLogs(),
              media: storage.listMedia(),
              mediaDir: storage.mediaDir,
              capabilities,
              updateState: updater.getState(),
            };
            return jsonOk(bootstrap);
          }

          if (pathname.startsWith("/api/") || pathname === "/api") {
            if (!accessGuard.isRequestAuthorized(req)) {
              return jsonErr(tServer(reqLang, "access_locked"), 401, { code: "ACCESS_LOCKED" });
            }
          }

          if (pathname === "/api/auth/login" && req.method === "POST") {
            const body = (await req.json()) as { email?: string; password?: string };
            const email = body.email?.trim() ?? "";
            const password = body.password ?? "";
            if (!email || !password) return jsonErr(tServer(reqLang, "auth_missing_credentials"));

            const terminalUuid = storage.getOrCreateTerminalUuid();
            volatileCreds = { email, password };
            pendingMfa = null;

            const outcome = await client.login(email, password, terminalUuid);
            if (outcome.kind === "mfa_required") {
              pendingMfa = {
                status: "mfa_required",
                baseUrl: outcome.baseUrl,
                email,
                terminalUuid,
                mfaProcessId: outcome.mfaProcessId!,
                supportedMFATypes: outcome.supportedMFATypes ?? [2],
              };
              return jsonOk({ auth: currentAuthState() });
            }

            session = {
              email,
              baseUrl: outcome.baseUrl,
              regionCode: outcome.regionCode ?? "EU",
              token: outcome.token!,
              refreshToken: outcome.refreshToken,
              terminalUuid,
              terminalBound: true,
              savedAt: Date.now(),
            };
            storage.saveSession(session);
            const list = await refreshCameraList();
            return jsonOk({ auth: currentAuthState(), cameras: list, stores: buildStores() });
          }

          if (pathname === "/api/auth/mfa/request" && req.method === "POST") {
            if (!pendingMfa || !volatileCreds) return jsonErr(tServer(reqLang, "auth_no_mfa"), 400);
            const body = (await req.json()) as { mfaType?: number };
            const mfaType = body.mfaType === 1 ? 1 : 2;
            await client.requestMfa(
              pendingMfa.baseUrl,
              volatileCreds.email,
              volatileCreds.password,
              pendingMfa.terminalUuid,
              mfaType,
            );
            pendingMfa = { ...pendingMfa, sentMfaType: mfaType };
            return jsonOk({ auth: currentAuthState() });
          }

          if (pathname === "/api/auth/mfa/verify" && req.method === "POST") {
            if (!pendingMfa) return jsonErr(tServer(reqLang, "auth_no_mfa"), 400);
            const body = (await req.json()) as { code?: string; mfaType?: number };
            const code = (body.code ?? "").replace(/\s|-/g, "");
            if (!code) return jsonErr(tServer(reqLang, "auth_missing_mfa_code"));
            const mfaType = body.mfaType === 1 ? 1 : 2;

            const verified = await client.verifyMfa(
              pendingMfa.baseUrl,
              pendingMfa.email,
              code,
              pendingMfa.mfaProcessId,
              mfaType,
            );
            session = {
              email: pendingMfa.email,
              baseUrl: verified.baseUrl,
              regionCode: verified.regionCode,
              token: verified.token,
              refreshToken: verified.refreshToken,
              terminalUuid: pendingMfa.terminalUuid,
              terminalBound: true,
              savedAt: Date.now(),
            };
            pendingMfa = null;
            storage.saveSession(session);
            const list = await refreshCameraList();
            return jsonOk({ auth: currentAuthState(), cameras: list, stores: buildStores() });
          }

          if (pathname === "/api/auth/logout" && req.method === "POST") {
            streams.stopAll();
            client.resetServiceCache();
            pendingMfa = null;
            volatileCreds = null;
            session = null;
            cameras = [];
            cloudFamilies = [];
            storage.clearSession();
            return jsonOk({ auth: currentAuthState() });
          }

          if (pathname === "/api/cameras/refresh" && req.method === "POST") {
            if (!session) return jsonErr(tServer(reqLang, "auth_login_first"), 401);
            const list = await refreshCameraList();
            return jsonOk({ cameras: list, stores: buildStores() });
          }

          if (pathname === "/api/stores" && req.method === "POST") {
            const body = (await req.json()) as Partial<Store>;
            const name = body.name?.trim();
            if (!name) return jsonErr(tServer(reqLang, "store_name_required"));

            const defaultFam = cloudFamilies.find((f) => f.isDefault) ?? cloudFamilies[0];
            if (session && defaultFam) {
              const roomId = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
              await client.upsertCloudRoom(
                session.baseUrl,
                session.token,
                session.terminalUuid,
                defaultFam.id,
                roomId,
                name,
              );
              const id = `${defaultFam.id}:${roomId}`;
              workspace.storeMeta[id] = {
                address: body.address?.trim() ?? "",
                networkKind: body.networkKind === "4g-modem" ? "4g-modem" : "wired",
              };
              storage.saveWorkspace(workspace);
              cloudFamilies = await client.listFamilies(
                session.baseUrl,
                session.token,
                session.terminalUuid,
              );
              const stores = buildStores();
              const store = stores.find((s) => s.id === id);
              return jsonOk({ store, stores });
            }

            const store: Store = {
              id: `store-${crypto.randomUUID().slice(0, 8)}`,
              name,
              address: body.address?.trim() ?? "",
              networkKind: body.networkKind === "4g-modem" ? "4g-modem" : "wired",
              cameraIds: Array.isArray(body.cameraIds) ? body.cameraIds : [],
              createdAt: Date.now(),
              source: "local",
            };
            workspace.stores.push(store);
            storage.saveWorkspace(workspace);
            return jsonOk({ store, stores: buildStores() });
          }

          const storeMatch = pathname.match(/^\/api\/stores\/([^/]+)$/);
          if (storeMatch) {
            const storeId = decodeURIComponent(storeMatch[1]!);
            const allStores = buildStores();
            const existing = allStores.find((s) => s.id === storeId);
            if (!existing) return jsonErr(tServer(reqLang, "store_not_found"), 404);

            if (req.method === "PATCH") {
              const body = (await req.json()) as Partial<Store>;
              const cleanName = body.name?.trim();
              if (existing.source === "cloud" && existing.familyId && existing.roomId) {
                if (cleanName && session && existing.roomId !== "other") {
                  await client.upsertCloudRoom(
                    session.baseUrl,
                    session.token,
                    session.terminalUuid,
                    existing.familyId,
                    existing.roomId,
                    cleanName,
                  );
                  cloudFamilies = await client.listFamilies(
                    session.baseUrl,
                    session.token,
                    session.terminalUuid,
                  );
                }
                const prevMeta = workspace.storeMeta[storeId] ?? {};
                workspace.storeMeta[storeId] = {
                  address: body.address !== undefined ? body.address.trim() : prevMeta.address,
                  networkKind:
                    body.networkKind === "4g-modem" || body.networkKind === "wired"
                      ? body.networkKind
                      : prevMeta.networkKind,
                };
                storage.saveWorkspace(workspace);
                const stores = buildStores();
                return jsonOk({ store: stores.find((s) => s.id === storeId), stores });
              }

              const idx = workspace.stores.findIndex((s) => s.id === storeId);
              if (idx === -1) return jsonErr(tServer(reqLang, "store_not_found"), 404);
              const prev = workspace.stores[idx]!;
              const next: Store = {
                ...prev,
                name: cleanName || prev.name,
                address: body.address !== undefined ? body.address.trim() : prev.address,
                networkKind:
                  body.networkKind === "4g-modem" || body.networkKind === "wired"
                    ? body.networkKind
                    : prev.networkKind,
                cameraIds: Array.isArray(body.cameraIds) ? body.cameraIds : prev.cameraIds,
                source: "local",
              };
              workspace.stores[idx] = next;
              storage.saveWorkspace(workspace);
              return jsonOk({ store: next, stores: buildStores() });
            }

            if (req.method === "DELETE") {
              if (existing.source === "cloud" && existing.familyId && existing.roomId) {
                if (existing.roomId === "other") {
                  return jsonErr(tServer(reqLang, "store_system_undeletable"), 400);
                }
                if (!session) return jsonErr(tServer(reqLang, "auth_login_first"), 401);
                await client.deleteCloudRoom(
                  session.baseUrl,
                  session.token,
                  session.terminalUuid,
                  existing.familyId,
                  existing.roomId,
                );
                cloudFamilies = await client.listFamilies(
                  session.baseUrl,
                  session.token,
                  session.terminalUuid,
                );
              } else {
                const idx = workspace.stores.findIndex((s) => s.id === storeId);
                if (idx !== -1) workspace.stores.splice(idx, 1);
              }
              delete workspace.storeMeta[storeId];
              for (const [cid, ov] of Object.entries(workspace.roomOverrides)) {
                if (ov === storeId) delete workspace.roomOverrides[cid];
              }
              storage.saveWorkspace(workspace);
              return jsonOk({ stores: buildStores() });
            }
          }

          const camPatchMatch = pathname.match(/^\/api\/cameras\/([^/]+)$/);
          if (camPatchMatch && req.method === "PATCH") {
            const deviceId = decodeURIComponent(camPatchMatch[1]!);
            const body = (await req.json()) as { customName?: string; storeId?: string | null };
            if (body.customName !== undefined) {
              const clean = body.customName.trim();
              if (clean && session) {
                await client.setDeviceNickname(
                  session.baseUrl,
                  session.token,
                  session.terminalUuid,
                  deviceId,
                  clean,
                );
                const cam = cameras.find((c) => c.deviceId === deviceId);
                if (cam) {
                  cam.alias = clean;
                  cam.cloudNickname = clean;
                }
                delete workspace.customNames[deviceId];
              } else if (clean) {
                workspace.customNames[deviceId] = clean;
              } else {
                delete workspace.customNames[deviceId];
              }
            }
            if (body.storeId !== undefined) {
              const cam = cameras.find((c) => c.deviceId === deviceId);
              const cloudStoreId = cam
                ? `${cam.familyId ?? "default"}:${cam.roomId ?? "other"}`
                : "";
              if (body.storeId === cloudStoreId) {
                delete workspace.roomOverrides[deviceId];
              } else {
                workspace.roomOverrides[deviceId] = body.storeId ?? "";
              }
            }
            storage.saveWorkspace(workspace);
            streams.syncCameras(enrichedCameras());
            return jsonOk({ cameras: enrichedCameras(), stores: buildStores() });
          }

          if (pathname === "/api/settings" && req.method === "PATCH") {
            const body = (await req.json()) as Partial<DashboardSettings>;
            const allowedFps = new Set([0.5, 1, 2, 3, 5, 10, 30]);
            const allowedCycle = new Set([0, 15, 30, 60]);
            if (body.gridFps && allowedFps.has(body.gridFps)) {
              workspace.settings.gridFps = body.gridFps;
            }
            if (body.gridResolution === "VGA" || body.gridResolution === "HD") {
              workspace.settings.gridResolution = body.gridResolution;
            }
            if (body.gridTransport === "webcodecs" || body.gridTransport === "mjpeg") {
              workspace.settings.gridTransport = body.gridTransport;
            }
            if (body.autoCycleSeconds !== undefined && allowedCycle.has(body.autoCycleSeconds)) {
              workspace.settings.autoCycleSeconds = body.autoCycleSeconds;
            }
            if (body.language !== undefined) {
              workspace.settings.language = normalizeLanguagePreference(body.language);
            }
            storage.saveWorkspace(workspace);
            streams.notifyGridSettingsChanged();
            return jsonOk({ settings: workspace.settings });
          }

          if (pathname === "/api/updates" && req.method === "GET") {
            return jsonOk(updater.getState());
          }

          if (pathname === "/api/updates/check" && req.method === "POST") {
            return jsonOk(await updater.checkForUpdate());
          }

          if (pathname === "/api/updates/apply" && req.method === "POST") {
            if (!updater.applyUpdate) {
              return jsonErr(tServer(reqLang, "update_auto_unsupported"), 400);
            }
            return jsonOk(await updater.applyUpdate());
          }

          const audioCfgMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/audio-config$/);
          if (audioCfgMatch && req.method === "POST") {
            if (!session) return jsonErr(tServer(reqLang, "auth_required"), 401);
            const deviceId = decodeURIComponent(audioCfgMatch[1]!);
            const body = (await req.json()) as { micVolume?: number; micMuted?: boolean };
            await client.setMicrophoneConfig(
              session.baseUrl,
              session.token,
              session.terminalUuid,
              deviceId,
              { volume: body.micVolume, mute: body.micMuted },
            );
            return jsonOk({ ok: true });
          }

          if (pathname === "/api/media" && req.method === "GET") {
            return jsonOk({ media: storage.listMedia(), mediaDir: storage.mediaDir });
          }

          const saveSnapMatch = pathname.match(/^\/api\/media\/snapshot\/([^/]+)$/);
          if (saveSnapMatch && req.method === "POST") {
            const deviceId = decodeURIComponent(saveSnapMatch[1]!);
            const cam = findCamera(deviceId);
            if (!cam) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const jpeg = await streams.captureSnapshot(deviceId);
            const cameraName = cam.customName?.trim() || cam.alias || cam.deviceModel;
            const item = storage.saveMediaFile(
              {
                kind: "snapshot",
                deviceId,
                cameraName,
                storeName: storeNameForCamera(deviceId),
                mimeType: "image/jpeg",
              },
              "jpg",
              jpeg,
            );
            streams.pushLocalizedLog(
              "info",
              "log_snapshot_saved",
              { filename: item.filename },
              deviceId,
            );
            return jsonOk({ item, media: storage.listMedia(), mediaDir: storage.mediaDir });
          }

          const saveClipMatch = pathname.match(/^\/api\/media\/clip\/([^/]+)$/);
          if (saveClipMatch && req.method === "POST") {
            const deviceId = decodeURIComponent(saveClipMatch[1]!);
            const cam = findCamera(deviceId);
            if (!cam) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const mp4 = await streams.captureMp4Clip(deviceId, 4);
            const cameraName = cam.customName?.trim() || cam.alias || cam.deviceModel;
            const item = storage.saveMediaFile(
              {
                kind: "clip",
                deviceId,
                cameraName,
                storeName: storeNameForCamera(deviceId),
                mimeType: "video/mp4",
                durationSec: 4,
              },
              "mp4",
              mp4,
            );
            streams.pushLocalizedLog(
              "info",
              "log_clip_saved",
              { filename: item.filename },
              deviceId,
            );
            return jsonOk({ item, media: storage.listMedia(), mediaDir: storage.mediaDir });
          }

          const mediaFileMatch = pathname.match(/^\/api\/media\/([^/]+)\/file$/);
          if (mediaFileMatch && req.method === "GET") {
            const id = decodeURIComponent(mediaFileMatch[1]!);
            const found = storage.getMediaItem(id);
            if (!found) return jsonErr(tServer(reqLang, "file_not_found"), 404);
            const { item, filePath } = found;
            const download = searchParams.get("download") === "1";
            const size = statSync(filePath).size;
            const range = req.headers.get("range");
            const baseHeaders: Record<string, string> = {
              "Content-Type": item.mimeType,
              "Accept-Ranges": "bytes",
              "Cache-Control": "no-store",
              "Content-Disposition": contentDisposition(
                download ? "attachment" : "inline",
                item.filename,
              ),
            };

            if (range && !download) {
              const m = range.match(/bytes=(\d+)-(\d*)/);
              if (m) {
                const start = Math.min(Number(m[1]), Math.max(0, size - 1));
                const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
                const bytes = readFileSync(filePath).subarray(start, end + 1);
                return new Response(new Uint8Array(bytes), {
                  status: 206,
                  headers: {
                    ...baseHeaders,
                    "Content-Range": `bytes ${start}-${end}/${size}`,
                    "Content-Length": String(bytes.length),
                  },
                });
              }
            }

            const bytes = readFileSync(filePath);
            return new Response(new Uint8Array(bytes), {
              headers: { ...baseHeaders, "Content-Length": String(bytes.length) },
            });
          }

          const mediaDelMatch = pathname.match(/^\/api\/media\/([^/]+)$/);
          if (mediaDelMatch && req.method === "DELETE") {
            const id = decodeURIComponent(mediaDelMatch[1]!);
            if (!storage.deleteMediaItem(id)) {
              return jsonErr(tServer(reqLang, "file_not_found"), 404);
            }
            return jsonOk({ media: storage.listMedia(), mediaDir: storage.mediaDir });
          }

          const capMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/capabilities$/);
          if (capMatch && req.method === "GET") {
            if (!session) return jsonErr(tServer(reqLang, "auth_required"), 401);
            const deviceId = decodeURIComponent(capMatch[1]!);
            const snap = await client.getCapabilitySnapshot(
              session.baseUrl,
              session.token,
              session.terminalUuid,
              deviceId,
            );
            return jsonOk(snap);
          }

          const privMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/privacy$/);
          if (privMatch && req.method === "POST") {
            if (!session) return jsonErr(tServer(reqLang, "auth_required"), 401);
            const deviceId = decodeURIComponent(privMatch[1]!);
            const body = (await req.json()) as { enabled?: boolean };
            const enabled = Boolean(body.enabled);
            await client.setPrivacyMode(
              session.baseUrl,
              session.token,
              session.terminalUuid,
              deviceId,
              enabled,
            );
            streams.pushLocalizedLog(
              "info",
              "log_privacy_toggled",
              { state: tServer(reqLang, enabled ? "state_on" : "state_off") },
              deviceId,
            );
            return jsonOk({ privacyOn: enabled });
          }

          const ptzMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/ptz$/);
          if (ptzMatch && req.method === "POST") {
            if (!session) return jsonErr(tServer(reqLang, "auth_required"), 401);
            const deviceId = decodeURIComponent(ptzMatch[1]!);
            const body = (await req.json()) as { x?: number; y?: number };
            await client.moveMotor(
              session.baseUrl,
              session.token,
              session.terminalUuid,
              deviceId,
              Number(body.x ?? 0),
              Number(body.y ?? 0),
            );
            return jsonOk({ ok: true });
          }

          const recDaysMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/recordings\/days$/);
          if (recDaysMatch && req.method === "GET") {
            if (!session) return jsonErr(tServer(reqLang, "auth_required"), 401);
            const deviceId = decodeURIComponent(recDaysMatch[1]!);
            const month =
              searchParams.get("month") ?? new Date().toISOString().slice(0, 7).replace("-", "");
            const days = await client.searchRecordingDays(
              session.baseUrl,
              session.token,
              session.terminalUuid,
              deviceId,
              month,
            );
            return jsonOk({ month, days });
          }

          const recListMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/recordings$/);
          if (recListMatch && req.method === "GET") {
            if (!session) return jsonErr(tServer(reqLang, "auth_required"), 401);
            const deviceId = decodeURIComponent(recListMatch[1]!);
            const date =
              searchParams.get("date") ?? new Date().toISOString().slice(0, 10).replaceAll("-", "");
            const data = await client.searchRecordingsOfDay(
              session.baseUrl,
              session.token,
              session.terminalUuid,
              deviceId,
              date,
            );
            return jsonOk(data);
          }

          const recPlayMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/recordings\/play$/);
          if (recPlayMatch && req.method === "GET") {
            if (!session) return jsonErr(tServer(reqLang, "auth_required"), 401);
            const deviceId = decodeURIComponent(recPlayMatch[1]!);
            const cam = findCamera(deviceId);
            if (!cam) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const start = Number(searchParams.get("start") ?? 0);
            const end = Number(searchParams.get("end") ?? 0);
            if (!start || !end || end <= start) {
              return jsonErr(tServer(reqLang, "invalid_time_range"));
            }
            return await streamSdRecordingMp4({
              client,
              baseUrl: session.baseUrl,
              token: session.token,
              terminalUuid: session.terminalUuid,
              device: cam,
              start,
              end,
              download: searchParams.get("download") === "1",
              ffmpegPath: resolvedFfmpegPath,
              getLang: () => reqLang,
              signal: req.signal,
              registerCleanup: (cleanup) => streams.registerCleanup(cleanup),
            });
          }

          const mjpegMatch = pathname.match(/^\/api\/stream\/([^/]+)\/mjpeg$/);
          if (mjpegMatch && req.method === "GET") {
            const deviceId = decodeURIComponent(mjpegMatch[1]!);
            if (!findCamera(deviceId)) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            let unsub: (() => void) | null = null;
            let closed = false;
            let busy = false;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                unsub = streams.subscribeMjpeg(deviceId, (jpeg) => {
                  if (closed || busy) return;
                  busy = true;
                  try {
                    const head = Buffer.from(
                      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
                      "ascii",
                    );
                    controller.enqueue(head);
                    controller.enqueue(jpeg);
                    controller.enqueue(Buffer.from("\r\n", "ascii"));
                  } catch {
                    closed = true;
                    unsub?.();
                  } finally {
                    busy = false;
                  }
                });
              },
              cancel() {
                closed = true;
                unsub?.();
              },
            });
            req.signal.addEventListener("abort", () => {
              closed = true;
              unsub?.();
            });
            return new Response(stream, {
              headers: {
                "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                "Cache-Control": "no-store, no-cache, must-revalidate",
                Connection: "close",
              },
            });
          }

          const audioMatch = pathname.match(/^\/api\/stream\/([^/]+)\/audio\.mp3$/);
          if (audioMatch && req.method === "GET") {
            const deviceId = decodeURIComponent(audioMatch[1]!);
            if (!findCamera(deviceId)) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            let unsub: (() => void) | null = null;
            let closed = false;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                unsub = streams.subscribeAudio(deviceId, (chunk) => {
                  if (closed) return;
                  try {
                    controller.enqueue(chunk);
                  } catch {
                    closed = true;
                    unsub?.();
                  }
                });
              },
              cancel() {
                closed = true;
                unsub?.();
              },
            });
            req.signal.addEventListener("abort", () => {
              closed = true;
              unsub?.();
            });
            return new Response(stream, {
              headers: {
                "Content-Type": "audio/mpeg",
                "Cache-Control": "no-store",
              },
            });
          }

          const snapMatch = pathname.match(/^\/api\/stream\/([^/]+)\/snapshot\.jpg$/);
          if (snapMatch && req.method === "GET") {
            const deviceId = decodeURIComponent(snapMatch[1]!);
            const cam = findCamera(deviceId);
            if (!cam) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const jpeg = await streams.captureSnapshot(deviceId);
            return new Response(new Uint8Array(jpeg), {
              headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "no-store",
                "Content-Disposition": contentDisposition("inline", `${cam.alias}-snapshot.jpg`),
              },
            });
          }

          const clipMatch = pathname.match(/^\/api\/stream\/([^/]+)\/clip\.mp4$/);
          if (clipMatch && req.method === "GET") {
            const deviceId = decodeURIComponent(clipMatch[1]!);
            const cam = findCamera(deviceId);
            if (!cam) return jsonErr(tServer(reqLang, "camera_not_found"), 404);
            const mp4 = await streams.captureMp4Clip(deviceId, 4);
            return new Response(new Uint8Array(mp4), {
              headers: {
                "Content-Type": "video/mp4",
                "Cache-Control": "no-store",
                "Content-Disposition": contentDisposition("attachment", `${cam.alias}-clip.mp4`),
              },
            });
          }

          if (pathname === "/api/events" && req.method === "GET") {
            let unsub: (() => void) | null = null;
            let keepAlive: ReturnType<typeof setInterval> | null = null;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                const send = (event: string, data: unknown) => {
                  controller.enqueue(
                    Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, "utf8"),
                  );
                };
                send("telemetry", streams.getAllTelemetry());
                unsub = streams.subscribeEvents((ev) => {
                  try {
                    send(ev.type, ev.data);
                  } catch {
                    unsub?.();
                  }
                });
                keepAlive = setInterval(() => {
                  try {
                    controller.enqueue(Buffer.from(": ping\n\n", "utf8"));
                  } catch {
                    if (keepAlive) clearInterval(keepAlive);
                  }
                }, 15_000);
              },
              cancel() {
                unsub?.();
                if (keepAlive) clearInterval(keepAlive);
              },
            });
            req.signal.addEventListener("abort", () => {
              unsub?.();
              if (keepAlive) clearInterval(keepAlive);
            });
            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            });
          }

          if (
            hasStaticDir &&
            !pathname.startsWith("/api/") &&
            pathname !== "/api" &&
            !pathname.startsWith("/ws/") &&
            (req.method === "GET" || req.method === "HEAD")
          ) {
            return serveStaticAsset(pathname, reqLang);
          }

          return jsonErr(tServer(reqLang, "not_found"), 404);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = err instanceof TapoCloudError && err.isAuthError ? 401 : 500;
          return jsonErr(msg, status);
        }
      });
    },
    websocket: {
      open(ws) {
        const { kind, deviceId, quality } = ws.data;
        if (kind === "audio") {
          ws.data.unsub = streams.subscribeRawAudio(deviceId, (mulaw) => {
            try {
              ws.sendBinary(mulaw);
            } catch {
              ws.data.unsub?.();
            }
          });
          return;
        }

        if (kind === "talk") {
          ws.data.talkHandle = streams.openTalkSession(deviceId, {
            onReady: () => {
              try {
                ws.sendText(JSON.stringify({ type: "ready" }));
              } catch {
                // socket closed
              }
            },
            onError: (message) => {
              try {
                ws.sendText(JSON.stringify({ type: "error", message }));
              } catch {
                // socket closed
              }
            },
          });
          return;
        }

        if (kind === "ts") {
          ws.data.unsub = streams.subscribeTs(deviceId, quality ?? "grid", (evKind, payload) => {
            try {
              if (evKind === "chunk") {
                const frame = Buffer.allocUnsafe(1 + payload.length);
                frame[0] = 0x01;
                payload.copy(frame, 1);
                ws.sendBinary(frame);
              } else {
                ws.sendBinary(Buffer.from([0x03]));
              }
            } catch {
              ws.data.unsub?.();
            }
          });
          return;
        }

        ws.data.unsub = streams.subscribeFmp4(deviceId, (evKind, payload, mime) => {
          try {
            if (evKind === "init") {
              const mimeBuf = Buffer.from(mime ?? 'video/mp4; codecs="avc1.640028"', "ascii");
              const frame = Buffer.allocUnsafe(2 + mimeBuf.length + payload.length);
              frame[0] = 0x01;
              frame[1] = mimeBuf.length;
              mimeBuf.copy(frame, 2);
              payload.copy(frame, 2 + mimeBuf.length);
              ws.sendBinary(frame);
            } else if (evKind === "frag") {
              const frame = Buffer.allocUnsafe(1 + payload.length);
              frame[0] = 0x02;
              payload.copy(frame, 1);
              ws.sendBinary(frame);
            } else if (evKind === "reset") {
              ws.sendBinary(Buffer.from([0x03]));
            }
          } catch {
            ws.data.unsub?.();
          }
        });
      },
      message(ws, msg) {
        if (ws.data.kind === "talk" && ws.data.talkHandle && typeof msg !== "string") {
          const bytes = msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg);
          ws.data.talkHandle.sendAlaw(bytes);
        }
      },
      close(ws) {
        ws.data.unsub?.();
        ws.data.unsub = undefined;
        ws.data.talkHandle?.close();
        ws.data.talkHandle = undefined;
      },
    },
  };

  const server = Bun.serve<WsStreamData>(serveOptions);
  const actualPort = server.port ?? port;
  const urlHost =
    hostname === "0.0.0.0" || hostname === "::"
      ? "127.0.0.1"
      : hostname.includes(":") && !hostname.startsWith("[")
        ? `[${hostname}]`
        : hostname;
  const url = `http://${urlHost}:${actualPort}`;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    streams.stopAll();
    void server.stop(true);
  };

  return {
    server,
    port: actualPort,
    hostname,
    url,
    stop,
  };
}
