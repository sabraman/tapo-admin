import {
  CheckIcon,
  ChevronDownIcon,
  ImagesIcon,
  LayoutGridIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  VideoOffIcon,
} from "lucide-react";
import type React from "react";
import { Fragment, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AccessGateView } from "@/components/AccessGateView";
import { AuthView } from "@/components/AuthView";
import { CameraCard } from "@/components/CameraCard";
import { FocusTheater } from "@/components/FocusTheater";
import {
  CameraEditDialog,
  StoreFormDialog,
  SystemSettingsDialog,
} from "@/components/ManageDialogs";
import { MediaGalleryDialog } from "@/components/MediaGalleryDialog";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Group, GroupSeparator, GroupText } from "@/components/ui/group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { api, cameraLabel, findCameraStore, groupHealthMeta, isCameraOnline } from "@/lib/api";
import {
  deleteEmulatedStore,
  EMPTY_EMULATED_STATE,
  isSimulatedCamera,
  isSimulatedStore,
  loadEmulatedState,
  mergeDashboardWithEmulator,
  saveEmulatedState,
  updateEmulatedCamera,
  updateEmulatedStore,
  type EmulatedState,
} from "@/lib/debug-emulator";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  AuthState,
  CameraMeta,
  CameraTelemetry,
  DashboardBootstrap,
  DashboardSettings,
  MediaItem,
  NetworkKind,
  RelayEventLog,
  RuntimeCapabilities,
  Store,
} from "../shared/types";

type GridLayout = "auto" | "2" | "3" | "4";

const MAX_INLINE_STORES = 4;

const DebugEmulatorDock = lazy(() =>
  import("@/components/DebugEmulatorDock").then((mod) => ({ default: mod.DebugEmulatorDock })),
);

const DEFAULT_SETTINGS: DashboardSettings = {
  gridFps: 30,
  gridResolution: "VGA",
  gridTransport: "webcodecs",
  autoCycleSeconds: 0,
  language: "auto",
};

const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  ffmpegAvailable: true,
  debugEmulatorEnabled: false,
  desktopApp: false,
};

export function App(): React.ReactElement {
  const { lang, setLanguagePref, t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessUnlocked, setAccessUnlocked] = useState(true);
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities>(DEFAULT_CAPABILITIES);
  const [auth, setAuth] = useState<AuthState>({ status: "unauthenticated" });
  const [cameras, setCameras] = useState<CameraMeta[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, CameraTelemetry>>({});
  const [emulated, setEmulated] = useState<EmulatedState>(() => loadEmulatedState());
  const [logs, setLogs] = useState<RelayEventLog[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaDir, setMediaDir] = useState<string>("");
  const [settings, setSettings] = useState<DashboardSettings>(DEFAULT_SETTINGS);

  const [activeStoreId, setActiveStoreId] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [gridLayout, setGridLayout] = useState<GridLayout>("auto");
  const [viewMode, setViewMode] = useState<"grid" | "focus">("grid");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [autoCyclePaused, setAutoCyclePaused] = useState(false);

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryInitialId, setGalleryInitialId] = useState<string | null>(null);
  const [systemOpen, setSystemOpen] = useState(false);
  const [systemTab, setSystemTab] = useState<"stream" | "stores" | "diagnostics" | "account">(
    "stream",
  );
  const [editingCamera, setEditingCamera] = useState<CameraMeta | null>(null);
  const [storeDialogOpen, setStoreDialogOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);

  async function loadBootstrap() {
    try {
      const data = await api<DashboardBootstrap>("/api/bootstrap");
      setAccessRequired(Boolean(data.accessRequired));
      setAccessUnlocked(Boolean(data.accessUnlocked));
      setCapabilities(data.capabilities ?? DEFAULT_CAPABILITIES);
      setAuth(data.auth);
      setCameras(data.cameras);
      setStores(data.stores);
      setTelemetry(data.telemetry);
      setSettings(data.settings);
      setLogs(data.logs);
      setMedia(data.media ?? []);
      setMediaDir(data.mediaDir ?? "");
      if (data.accessUnlocked) {
        setLanguagePref(data.settings.language);
      }
    } catch (err) {
      toastManager.add({
        title: t("toastBootstrapError"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBootstrap();
  }, []);

  useEffect(() => {
    if (!accessUnlocked || auth.status !== "authenticated") return;
    const es = new EventSource("/api/events");
    es.addEventListener("telemetry", (ev) => {
      try {
        setTelemetry(JSON.parse(ev.data) as Record<string, CameraTelemetry>);
      } catch {
        // ignore malformed telemetry frame
      }
    });
    es.addEventListener("log", (ev) => {
      try {
        const entry = JSON.parse(ev.data) as RelayEventLog;
        setLogs((prev) => [entry, ...prev].slice(0, 120));
      } catch {
        // ignore malformed log entry
      }
    });
    return () => es.close();
  }, [accessUnlocked, auth.status]);

  useEffect(() => {
    saveEmulatedState(emulated);
  }, [emulated]);

  const effectiveEmulated = capabilities.debugEmulatorEnabled ? emulated : EMPTY_EMULATED_STATE;

  const merged = useMemo(
    () => mergeDashboardWithEmulator(cameras, stores, telemetry, effectiveEmulated, lang),
    [cameras, stores, telemetry, effectiveEmulated, lang],
  );
  const effectiveCameras = merged.cameras;
  const effectiveStores = merged.stores;
  const effectiveTelemetry = merged.telemetry;

  useEffect(() => {
    if (
      activeStoreId !== "all" &&
      activeStoreId !== "unassigned" &&
      !effectiveStores.some((s) => s.id === activeStoreId)
    ) {
      setActiveStoreId("all");
    }
  }, [activeStoreId, effectiveStores]);

  const unassignedCount = useMemo(() => {
    const assigned = new Set(effectiveStores.flatMap((s) => s.cameraIds));
    return effectiveCameras.filter((c) => !assigned.has(c.deviceId)).length;
  }, [effectiveCameras, effectiveStores]);

  const visibleCameras = useMemo(() => {
    const assigned = new Set(effectiveStores.flatMap((s) => s.cameraIds));
    let base = effectiveCameras;
    if (activeStoreId === "unassigned") {
      base = effectiveCameras.filter((c) => !assigned.has(c.deviceId));
    } else if (activeStoreId !== "all") {
      const st = effectiveStores.find((s) => s.id === activeStoreId);
      const set = new Set(st?.cameraIds ?? []);
      base = effectiveCameras.filter((c) => set.has(c.deviceId));
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((c) => {
      const st = findCameraStore(effectiveStores, c.deviceId);
      return (
        cameraLabel(c).toLowerCase().includes(q) ||
        (st?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [effectiveCameras, effectiveStores, activeStoreId, searchQuery]);

  const focusedCamera = useMemo(
    () =>
      visibleCameras.find((c) => c.deviceId === focusedId) ??
      effectiveCameras.find((c) => c.deviceId === focusedId) ??
      visibleCameras[0] ??
      null,
    [visibleCameras, effectiveCameras, focusedId],
  );

  useEffect(() => {
    if (
      viewMode !== "focus" ||
      settings.autoCycleSeconds === 0 ||
      autoCyclePaused ||
      visibleCameras.length <= 1
    ) {
      return;
    }
    const timer = setInterval(() => {
      setFocusedId((curr) => {
        const idx = visibleCameras.findIndex((c) => c.deviceId === curr);
        const next = visibleCameras[(idx + 1) % visibleCameras.length];
        return next?.deviceId ?? curr;
      });
    }, settings.autoCycleSeconds * 1000);
    return () => clearInterval(timer);
  }, [viewMode, settings.autoCycleSeconds, autoCyclePaused, visibleCameras]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (systemOpen || galleryOpen || Boolean(editingCamera) || storeDialogOpen) {
        return;
      }
      if (e.key === "Escape" && viewMode === "focus") {
        setViewMode("grid");
      } else if (viewMode === "focus" && visibleCameras.length > 1) {
        if (e.key === "ArrowRight") stepFocus(1);
        if (e.key === "ArrowLeft") stepFocus(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    viewMode,
    visibleCameras,
    systemOpen,
    galleryOpen,
    editingCamera,
    storeDialogOpen,
    focusedCamera,
  ]);

  function openFocus(deviceId: string) {
    setFocusedId(deviceId);
    setViewMode("focus");
  }

  function stepFocus(dir: -1 | 1) {
    if (visibleCameras.length === 0) return;
    const idx = visibleCameras.findIndex((c) => c.deviceId === focusedCamera?.deviceId);
    const nextIdx = (Math.max(idx, 0) + dir + visibleCameras.length) % visibleCameras.length;
    setFocusedId(visibleCameras[nextIdx]!.deviceId);
  }

  function notifySavedMedia(title: string, item: MediaItem) {
    const openSaved = (id: string) => {
      toastManager.close(id);
      setGalleryInitialId(item.id);
      setGalleryOpen(true);
    };
    const toastId = toastManager.add({
      title,
      description: item.filename,
      type: "success",
      actionProps: {
        children: t("openGallery"),
        onClick: () => openSaved(toastId),
      },
      data: {
        rootProps: {
          style: { cursor: "pointer" },
          onClick: (e: React.MouseEvent) => {
            if ((e.target as HTMLElement).closest('[data-slot="toast-action"]')) return;
            openSaved(toastId);
          },
        },
      },
    });
  }

  async function captureSnapshotToGallery(deviceId: string) {
    if (isSimulatedCamera(deviceId)) {
      toastManager.add({
        title: t("toastSimCameraTitle"),
        description: t("toastSimSnapshotDesc"),
        type: "info",
      });
      return;
    }
    try {
      const res = await api<{ item: MediaItem; media: MediaItem[]; mediaDir: string }>(
        `/api/media/snapshot/${encodeURIComponent(deviceId)}`,
        { method: "POST" },
      );
      setMedia(res.media);
      setMediaDir(res.mediaDir);
      notifySavedMedia(t("toastSnapshotSaved"), res.item);
    } catch (err) {
      toastManager.add({
        title: t("toastSnapshotError"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    }
  }

  async function captureClipToGallery(deviceId: string) {
    if (isSimulatedCamera(deviceId)) {
      toastManager.add({
        title: t("toastSimCameraTitle"),
        description: t("toastSimClipDesc"),
        type: "info",
      });
      return;
    }
    try {
      toastManager.add({ title: t("toastRecordingClip"), type: "info" });
      const res = await api<{ item: MediaItem; media: MediaItem[]; mediaDir: string }>(
        `/api/media/clip/${encodeURIComponent(deviceId)}`,
        { method: "POST" },
      );
      setMedia(res.media);
      setMediaDir(res.mediaDir);
      notifySavedMedia(t("toastClipSaved"), res.item);
    } catch (err) {
      toastManager.add({
        title: t("toastClipError"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    }
  }

  async function deleteMedia(id: string) {
    const res = await api<{ media: MediaItem[]; mediaDir: string }>(
      `/api/media/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    setMedia(res.media);
    setMediaDir(res.mediaDir);
    toastManager.add({ title: t("toastFileDeleted"), type: "info" });
  }

  async function saveCameraMeta(
    deviceId: string,
    payload: { customName: string; storeId: string | null },
  ) {
    if (isSimulatedCamera(deviceId)) {
      setEmulated((prev) =>
        updateEmulatedCamera(prev, deviceId, {
          ...(payload.customName.trim() ? { name: payload.customName.trim() } : {}),
          storeId: payload.storeId,
        }),
      );
      toastManager.add({ title: t("toastSimCameraUpdated"), type: "success" });
      return;
    }
    const res = await api<{ cameras: CameraMeta[]; stores: Store[] }>(
      `/api/cameras/${encodeURIComponent(deviceId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
    setCameras(res.cameras);
    setStores(res.stores);
    toastManager.add({ title: t("toastCameraSaved"), type: "success" });
  }

  async function saveStore(data: { id?: string; name: string }) {
    const existing = data.id ? effectiveStores.find((s) => s.id === data.id) : undefined;
    const address = existing?.address ?? "";
    const networkKind: NetworkKind = existing?.networkKind ?? "wired";

    if (data.id && isSimulatedStore(data.id)) {
      setEmulated((prev) =>
        updateEmulatedStore(prev, data.id!, {
          name: data.name,
        }),
      );
      toastManager.add({
        title: t("toastSimStoreUpdated", { name: data.name }),
        type: "success",
      });
      return;
    }
    if (data.id) {
      const res = await api<{ stores: Store[] }>(`/api/stores/${encodeURIComponent(data.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: data.name,
          address,
          networkKind,
        }),
      });
      setStores(res.stores);
      toastManager.add({ title: t("toastStoreUpdated", { name: data.name }), type: "success" });
    } else {
      const res = await api<{ store: Store; stores: Store[] }>("/api/stores", {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          address,
          networkKind,
        }),
      });
      setStores(res.stores);
      toastManager.add({ title: t("toastStoreCreated", { name: res.store.name }), type: "success" });
    }
  }

  async function deleteStore(store: Store) {
    if (isSimulatedStore(store.id)) {
      setEmulated((prev) => deleteEmulatedStore(prev, store.id, false));
      if (activeStoreId === store.id) setActiveStoreId("all");
      toastManager.add({ title: t("toastSimStoreDeleted", { name: store.name }), type: "info" });
      return;
    }
    const res = await api<{ stores: Store[] }>(`/api/stores/${encodeURIComponent(store.id)}`, {
      method: "DELETE",
    });
    setStores(res.stores);
    if (activeStoreId === store.id) setActiveStoreId("all");
    toastManager.add({ title: t("toastStoreDeleted", { name: store.name }), type: "info" });
  }

  async function saveSettings(next: DashboardSettings) {
    const res = await api<{ settings: DashboardSettings }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(next),
    });
    setSettings(res.settings);
    setLanguagePref(res.settings.language);
  }

  async function refreshCameras() {
    const res = await api<{ cameras: CameraMeta[]; stores: Store[] }>("/api/cameras/refresh", {
      method: "POST",
    });
    setCameras(res.cameras);
    setStores(res.stores);
    toastManager.add({
      title: t("toastCamerasRefreshed"),
      description: t("toastCamerasRefreshedDesc", { count: res.cameras.length }),
      type: "success",
    });
  }

  async function lockDashboard() {
    await api("/api/access/lock", { method: "POST" });
    setSystemOpen(false);
    setGalleryOpen(false);
    setEditingCamera(null);
    setStoreDialogOpen(false);
    setAccessUnlocked(false);
    setAuth({ status: "unauthenticated" });
    setCameras([]);
    setStores([]);
    setTelemetry({});
    setLogs([]);
    setMedia([]);
    setMediaDir("");
  }

  async function logout() {
    const res = await api<{ auth: AuthState }>("/api/auth/logout", { method: "POST" });
    setAuth(res.auth);
    setCameras([]);
    setTelemetry({});
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Spinner />
        <span>{t("loadingDashboard")}</span>
      </div>
    );
  }

  if (accessRequired && !accessUnlocked) {
    return <AccessGateView onUnlocked={loadBootstrap} />;
  }

  if (auth.status !== "authenticated") {
    return (
      <AuthView
        accessUnlocked={accessUnlocked}
        auth={auth}
        onAuthenticated={loadBootstrap}
        onAuthUpdate={setAuth}
      />
    );
  }

  const onlineCount = effectiveCameras.filter((c) =>
    isCameraOnline(c, effectiveTelemetry[c.deviceId]),
  ).length;
  const overallHealth = groupHealthMeta(onlineCount, effectiveCameras.length);

  const storeOnlineCounts = new Map<string, number>();
  for (const st of effectiveStores) {
    let online = 0;
    for (const id of st.cameraIds) {
      const cam = effectiveCameras.find((c) => c.deviceId === id);
      if (cam && isCameraOnline(cam, effectiveTelemetry[id])) online += 1;
    }
    storeOnlineCounts.set(st.id, online);
  }

  let unassignedOnlineCount = 0;
  if (unassignedCount > 0) {
    const assigned = new Set(effectiveStores.flatMap((s) => s.cameraIds));
    for (const c of effectiveCameras) {
      if (!assigned.has(c.deviceId) && isCameraOnline(c, effectiveTelemetry[c.deviceId])) {
        unassignedOnlineCount += 1;
      }
    }
  }
  const unassignedHealth = groupHealthMeta(unassignedOnlineCount, unassignedCount);

  const inlineStores = (() => {
    if (effectiveStores.length <= MAX_INLINE_STORES) return effectiveStores;
    const slots = MAX_INLINE_STORES - 1;
    const head = effectiveStores.slice(0, slots - 1);
    const activeExtra = effectiveStores.find(
      (s) => s.id === activeStoreId && !head.some((h) => h.id === s.id),
    );
    return activeExtra ? [...head, activeExtra] : effectiveStores.slice(0, slots);
  })();
  const inlineStoreIds = new Set(inlineStores.map((s) => s.id));
  const hiddenStores = effectiveStores.filter((s) => !inlineStoreIds.has(s.id));

  const canFillRows =
    gridLayout === "auto"
      ? visibleCameras.length <= 4
      : gridLayout === "2" && visibleCameras.length <= 4;

  const gridClassName = (() => {
    if (gridLayout === "2") {
      return visibleCameras.length <= 4
        ? "grid-cols-1 md:grid-cols-2 auto-rows-fr h-full"
        : "grid-cols-1 md:grid-cols-2";
    }
    if (gridLayout === "3") return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
    if (gridLayout === "4") return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
    if (visibleCameras.length <= 1) return "grid-cols-1 h-full";
    if (visibleCameras.length <= 4) return "grid-cols-1 md:grid-cols-2 auto-rows-fr h-full";
    return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
  })();

  const selectStoreFilter = (storeId: string) => {
    setActiveStoreId(storeId);
    setViewMode("grid");
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* Header: unified connected coss Group bar (status + store filter + overflow + quick create) */}
      <header className="flex h-13 shrink-0 items-center justify-between gap-3 border-b bg-background/95 px-3 backdrop-blur-sm sm:px-4">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <Group aria-label={t("headerStatusAria")} className="items-stretch">
            <GroupText
              className={cn(
                "h-8 gap-2 px-2.5 text-xs font-semibold tabular-nums dark:bg-input/55",
                overallHealth.textClass,
              )}
              title={t("headerOnlineCountTitle", {
                online: onlineCount,
                total: effectiveCameras.length,
              })}
            >
              <span className="relative flex size-2 shrink-0">
                {overallHealth.pingClass && (
                  <span
                    className={cn(
                      "absolute inline-flex size-full animate-ping rounded-full opacity-60",
                      overallHealth.pingClass,
                    )}
                  />
                )}
                <span
                  className={cn(
                    "relative inline-flex size-2 rounded-full",
                    overallHealth.dotClass,
                  )}
                />
              </span>
              <span>
                {onlineCount}/{effectiveCameras.length}
              </span>
            </GroupText>

            <GroupSeparator />

            <Button
              aria-pressed={activeStoreId === "all"}
              className={cn(
                "h-8 gap-1.5 px-2.5 text-xs sm:h-8",
                activeStoreId === "all"
                  ? "z-1 font-semibold text-foreground dark:bg-input/90"
                  : "text-muted-foreground hover:text-foreground",
              )}
              data-pressed={activeStoreId === "all" ? "" : undefined}
              onClick={() => selectStoreFilter("all")}
              variant="outline"
            >
              <span>{t("filterAll")}</span>
              <span className="rounded bg-foreground/8 px-1.5 py-0.2 text-[11px] font-medium tabular-nums">
                {effectiveCameras.length}
              </span>
              {activeStoreId === "all" && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-x-2.5 bottom-0 h-0.5 rounded-full",
                    overallHealth.barClass,
                  )}
                />
              )}
            </Button>

            {inlineStores.map((store) => {
              const storeOnline = storeOnlineCounts.get(store.id) ?? 0;
              const storeTotal = store.cameraIds.length;
              const health = groupHealthMeta(storeOnline, storeTotal);
              const active = activeStoreId === store.id;
              return (
                <Fragment key={store.id}>
                  <GroupSeparator />
                  <Button
                    aria-pressed={active}
                    className={cn(
                      "h-8 gap-1.5 px-2.5 text-xs sm:h-8",
                      active
                        ? "z-1 font-semibold text-foreground dark:bg-input/90"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    data-pressed={active ? "" : undefined}
                    onClick={() => selectStoreFilter(store.id)}
                    variant="outline"
                  >
                    <span className={cn("size-1.5 shrink-0 rounded-full", health.dotClass)} />
                    <span className="max-w-28 truncate">{store.name}</span>
                    <span className="text-[11px] font-normal tabular-nums opacity-65">
                      {storeOnline}/{storeTotal}
                    </span>
                    {active && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "pointer-events-none absolute inset-x-2.5 bottom-0 h-0.5 rounded-full",
                          health.barClass,
                        )}
                      />
                    )}
                  </Button>
                </Fragment>
              );
            })}

            {unassignedCount > 0 &&
              effectiveStores.length > 0 &&
              (hiddenStores.length === 0 || activeStoreId === "unassigned") && (
                <>
                  <GroupSeparator />
                  <Button
                    aria-pressed={activeStoreId === "unassigned"}
                    className={cn(
                      "h-8 gap-1.5 px-2.5 text-xs sm:h-8",
                      activeStoreId === "unassigned"
                        ? "z-1 font-semibold text-foreground dark:bg-input/90"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    data-pressed={activeStoreId === "unassigned" ? "" : undefined}
                    onClick={() => selectStoreFilter("unassigned")}
                    variant="outline"
                  >
                    <span className={cn("size-1.5 shrink-0 rounded-full", unassignedHealth.dotClass)} />
                    <span>{t("filterUnassigned")}</span>
                    <span className="text-[11px] font-normal tabular-nums opacity-65">
                      {unassignedOnlineCount}/{unassignedCount}
                    </span>
                    {activeStoreId === "unassigned" && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "pointer-events-none absolute inset-x-2.5 bottom-0 h-0.5 rounded-full",
                          unassignedHealth.barClass,
                        )}
                      />
                    )}
                  </Button>
                </>
              )}

            {hiddenStores.length > 0 && (
              <>
                <GroupSeparator />
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        aria-label={t("moreStoresAria", { count: hiddenStores.length })}
                        className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground sm:h-8"
                        variant="outline"
                      />
                    }
                  >
                    <span className="tabular-nums">+{hiddenStores.length}</span>
                    <ChevronDownIcon aria-hidden="true" />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-64">
                    <MenuItem onClick={() => selectStoreFilter("all")}>
                      <span className={cn("size-1.5 shrink-0 rounded-full", overallHealth.dotClass)} />
                      <span className="flex-1">{t("filterAllStores")}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {onlineCount}/{effectiveCameras.length}
                      </span>
                      {activeStoreId === "all" && <CheckIcon aria-hidden="true" />}
                    </MenuItem>
                    <MenuSeparator />
                    {effectiveStores.map((st) => {
                      const online = storeOnlineCounts.get(st.id) ?? 0;
                      const total = st.cameraIds.length;
                      const health = groupHealthMeta(online, total);
                      return (
                        <MenuItem key={st.id} onClick={() => selectStoreFilter(st.id)}>
                          <span className={cn("size-1.5 shrink-0 rounded-full", health.dotClass)} />
                          <span className="flex-1 truncate">{st.name}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {online}/{total}
                          </span>
                          {activeStoreId === st.id && <CheckIcon aria-hidden="true" />}
                        </MenuItem>
                      );
                    })}
                    {unassignedCount > 0 && (
                      <>
                        <MenuSeparator />
                        <MenuItem onClick={() => selectStoreFilter("unassigned")}>
                          <span className={cn("size-1.5 shrink-0 rounded-full", unassignedHealth.dotClass)} />
                          <span className="flex-1">{t("filterUnassigned")}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {unassignedOnlineCount}/{unassignedCount}
                          </span>
                          {activeStoreId === "unassigned" && <CheckIcon aria-hidden="true" />}
                        </MenuItem>
                      </>
                    )}
                  </MenuPopup>
                </Menu>
              </>
            )}

            <GroupSeparator />

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={t("createStoreAria")}
                    className="h-8 w-8 px-0 text-muted-foreground hover:text-foreground sm:h-8"
                    onClick={() => {
                      setEditingStore(null);
                      setStoreDialogOpen(true);
                    }}
                    variant="outline"
                  />
                }
              >
                <PlusIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup>{t("createStoreTooltip")}</TooltipPopup>
            </Tooltip>
          </Group>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {effectiveCameras.length > 2 && viewMode === "grid" && (
            <InputGroup className="hidden w-48 lg:flex">
              <InputGroupAddon align="inline-start">
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t("searchCameraAria")}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("searchCameraPlaceholder")}
                size="sm"
                type="search"
                value={searchQuery}
              />
            </InputGroup>
          )}

          {viewMode === "grid" && visibleCameras.length > 1 && (
            <div className="hidden md:block">
              <SegmentedControl
                aria-label={t("gridLayoutAria")}
                render={
                  <RadioGroupPrimitive
                    onValueChange={(v) => setGridLayout(String(v) as GridLayout)}
                    value={gridLayout}
                  />
                }
                size="sm"
              >
                <SegmentedControlItem render={<RadioPrimitive.Root value="auto" />}>
                  {t("gridLayoutAuto")}
                </SegmentedControlItem>
                <SegmentedControlItem render={<RadioPrimitive.Root value="2" />}>
                  2×2
                </SegmentedControlItem>
                <SegmentedControlItem render={<RadioPrimitive.Root value="3" />}>
                  3×3
                </SegmentedControlItem>
                <SegmentedControlItem render={<RadioPrimitive.Root value="4" />}>
                  4×4
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
          )}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t("galleryAria")}
                  onClick={() => setGalleryOpen(true)}
                  size="sm"
                  variant="outline"
                />
              }
            >
              <ImagesIcon aria-hidden="true" />
              <span className="hidden sm:inline">{t("galleryLabel")}</span>
              {media.length > 0 && (
                <span className="rounded bg-muted px-1.5 py-0.2 text-[11px] text-muted-foreground tabular-nums">
                  {media.length}
                </span>
              )}
            </TooltipTrigger>
            <TooltipPopup>{t("galleryTooltip")}</TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t("systemAria")}
                  onClick={() => {
                    setSystemTab("stream");
                    setSystemOpen(true);
                  }}
                  size="sm"
                  variant="outline"
                />
              }
            >
              <Settings2Icon aria-hidden="true" />
              <span className="hidden sm:inline">{t("systemLabel")}</span>
            </TooltipTrigger>
            <TooltipPopup>{t("systemTooltip")}</TooltipPopup>
          </Tooltip>
        </div>
      </header>

      {/* Main Video Wall / Focus View filling all available space */}
      <main className="min-h-0 flex-1 overflow-y-auto p-2.5 sm:p-3">
        {visibleCameras.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {effectiveCameras.length === 0 ? (
                  <VideoOffIcon aria-hidden="true" />
                ) : (
                  <LayoutGridIcon aria-hidden="true" />
                )}
              </EmptyMedia>
              <EmptyTitle>
                {effectiveCameras.length === 0
                  ? t("emptyNoCamerasTitle")
                  : t("emptyNoFilteredTitle")}
              </EmptyTitle>
              <EmptyDescription>
                {effectiveCameras.length === 0
                  ? t("emptyNoCamerasDesc")
                  : t("emptyNoFilteredDesc")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap justify-center gap-2">
                {effectiveCameras.length === 0 ? (
                  <Button onClick={() => void refreshCameras()}>{t("refreshFromCloud")}</Button>
                ) : (
                  <>
                    <Button
                      onClick={() => {
                        setActiveStoreId("all");
                        setSearchQuery("");
                      }}
                      variant="outline"
                    >
                      {t("showAllCameras")}
                    </Button>
                    <Button
                      onClick={() => {
                        setSystemTab("stores");
                        setSystemOpen(true);
                      }}
                    >
                      {t("configureStores")}
                    </Button>
                  </>
                )}
              </div>
            </EmptyContent>
          </Empty>
        ) : viewMode === "focus" && focusedCamera ? (
          <FocusTheater
            autoCyclePaused={autoCyclePaused}
            camera={focusedCamera}
            cameras={visibleCameras}
            onClipSave={captureClipToGallery}
            onEditCamera={(cam) => setEditingCamera(cam)}
            onExitFocus={() => setViewMode("grid")}
            onSelectCamera={(id) => openFocus(id)}
            onSnapshot={captureSnapshotToGallery}
            onStepCamera={stepFocus}
            onToggleAutoCyclePause={() => setAutoCyclePaused((p) => !p)}
            settings={settings}
            storeName={findCameraStore(effectiveStores, focusedCamera.deviceId)?.name}
            telemetryMap={effectiveTelemetry}
          />
        ) : (
          <div className={cn("grid w-full gap-2.5 sm:gap-3", gridClassName)}>
            {visibleCameras.map((cam) => {
              const store = findCameraStore(effectiveStores, cam.deviceId);
              return (
                <CameraCard
                  camera={cam}
                  fillHeight={canFillRows}
                  key={cam.deviceId}
                  onEdit={() => setEditingCamera(cam)}
                  onFocus={() => openFocus(cam.deviceId)}
                  onSnapshot={() => void captureSnapshotToGallery(cam.deviceId)}
                  settings={settings}
                  showStoreBadge={activeStoreId === "all"}
                  storeName={store?.name}
                  telemetry={effectiveTelemetry[cam.deviceId]}
                />
              );
            })}
          </div>
        )}
      </main>

      {/* Media Gallery Dialog (shows saved snapshots, MP4 clips, and server path) */}
      <MediaGalleryDialog
        initialItemId={galleryInitialId}
        media={media}
        mediaDir={mediaDir}
        onDeleteMedia={deleteMedia}
        onOpenChange={(isOpen) => {
          setGalleryOpen(isOpen);
          if (!isOpen) setGalleryInitialId(null);
        }}
        open={galleryOpen}
      />

      {/* Secondary Dialogs: Settings/Diagnostics/Stores/Account */}
      <SystemSettingsDialog
        accessRequired={accessRequired}
        auth={auth}
        cameras={effectiveCameras}
        capabilities={capabilities}
        initialTab={systemTab}
        logs={logs}
        onCreateStore={() => {
          setEditingStore(null);
          setStoreDialogOpen(true);
        }}
        onDeleteStore={deleteStore}
        onEditCamera={(cam) => setEditingCamera(cam)}
        onEditStore={(s) => {
          setEditingStore(s);
          setStoreDialogOpen(true);
        }}
        onLock={lockDashboard}
        onLogout={logout}
        onOpenChange={setSystemOpen}
        onRefreshCameras={refreshCameras}
        onSaveSettings={saveSettings}
        open={systemOpen}
        settings={settings}
        stores={effectiveStores}
        telemetry={effectiveTelemetry}
      />

      {/* Explicit Camera Edit Dialog (Save/Cancel dirty flow) */}
      <CameraEditDialog
        camera={editingCamera}
        onOpenChange={(isOpen) => {
          if (!isOpen) setEditingCamera(null);
        }}
        onSave={saveCameraMeta}
        open={Boolean(editingCamera)}
        stores={effectiveStores}
      />

      {/* Explicit Store Create/Edit Dialog */}
      <StoreFormDialog
        initialStore={editingStore}
        onOpenChange={setStoreDialogOpen}
        onSave={saveStore}
        open={storeDialogOpen}
      />

      {/* Floating Debug Emulator Dock */}
      {capabilities.debugEmulatorEnabled && (
        <Suspense fallback={null}>
          <DebugEmulatorDock
            allStores={effectiveStores}
            emulated={emulated}
            onChange={setEmulated}
            onFocusCamera={(id) => openFocus(id)}
            onSelectStoreFilter={selectStoreFilter}
            realStores={stores}
            storeOnlineCounts={storeOnlineCounts}
          />
        </Suspense>
      )}
    </div>
  );
}
