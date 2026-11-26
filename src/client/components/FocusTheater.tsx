import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BellOffIcon,
  BellRingIcon,
  CameraIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FilmIcon,
  HardDriveIcon,
  MapPinIcon,
  MicIcon,
  MicOffIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RadioIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SirenIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { CameraArchivePanel } from "@/components/CameraArchivePanel";
import { CameraSettingsPanel } from "@/components/CameraSettingsPanel";
import { VideoStreamStage } from "@/components/VideoStreamStage";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { api, cameraLabel, isCameraOnline, relayStatusMeta } from "@/lib/api";
import { useCameraAudio, useCameraTalk } from "@/lib/audio";
import { isSimulatedCamera } from "@/lib/debug-emulator";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  CameraCapabilitySnapshot,
  CameraMeta,
  CameraOrientation,
  CameraPreset,
  CameraSettingsSnapshot,
  CameraTelemetry,
  DashboardSettings,
  MediaItem,
} from "../../shared/types";

interface FocusTheaterProps {
  camera: CameraMeta;
  cameras: CameraMeta[];
  storeName?: string;
  telemetryMap: Record<string, CameraTelemetry>;
  settings: DashboardSettings;
  media?: MediaItem[];
  mediaDir?: string;
  autoCyclePaused: boolean;
  onToggleAutoCyclePause: () => void;
  onSelectCamera: (deviceId: string) => void;
  onStepCamera: (dir: -1 | 1) => void;
  onExitFocus: () => void;
  onEditCamera: (camera: CameraMeta) => void;
  onUpdateOrientation: (deviceId: string, orientation: CameraOrientation) => Promise<void>;
  onSnapshot: (deviceId: string) => Promise<void>;
  onClipSave: (deviceId: string) => Promise<void>;
  onMediaSaved?: (res: { item: MediaItem; media: MediaItem[]; mediaDir: string }) => void;
  onDeleteMedia?: (id: string) => Promise<void>;
  onOpenGallery?: (itemId?: string) => void;
}

const PTZ_STEPS = [
  { value: "5", label: "5°" },
  { value: "10", label: "10°" },
  { value: "20", label: "20°" },
  { value: "35", label: "35°" },
] as const;

const GAIN_STEPS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
  { value: "4", label: "4×" },
] as const;

export function FocusTheater({
  camera,
  cameras,
  storeName,
  telemetryMap,
  settings,
  media = [],
  mediaDir = "",
  autoCyclePaused,
  onToggleAutoCyclePause,
  onSelectCamera,
  onStepCamera,
  onExitFocus,
  onEditCamera,
  onUpdateOrientation,
  onSnapshot,
  onClipSave,
  onMediaSaved,
  onDeleteMedia,
  onOpenGallery,
}: FocusTheaterProps): React.ReactElement {
  const { lang, t } = useI18n();
  const telemetry = telemetryMap[camera.deviceId];
  const online = isCameraOnline(camera, telemetry);
  const label = cameraLabel(camera);
  const isSim = isSimulatedCamera(camera.deviceId);

  const [stageMode, setStageMode] = useState<"live" | "playback">("live");
  const audio = useCameraAudio(camera.deviceId, stageMode === "live" && online && !isSim);
  const talk = useCameraTalk(camera.deviceId, stageMode === "live" && online && !isSim);

  const [panelTab, setPanelTab] = useState<"control" | "settings">("control");
  const [ptzStep, setPtzStep] = useState<string>("10");
  const [ptzBusy, setPtzBusy] = useState(false);
  const [simPanOffset, setSimPanOffset] = useState({ x: 0, y: 0 });
  const [capturingSnap, setCapturingSnap] = useState(false);
  const [capturingClip, setCapturingClip] = useState(false);

  const [cap, setCap] = useState<CameraCapabilitySnapshot | null>(null);
  const [capLoading, setCapLoading] = useState(false);
  const [privacyDialogOpen, setPrivacyDialogOpen] = useState(false);
  const [pendingPrivacyTarget, setPendingPrivacyTarget] = useState<boolean>(false);
  const [privacySaving, setPrivacySaving] = useState(false);

  const [alarmBusy, setAlarmBusy] = useState(false);
  const [sirenBusy, setSirenBusy] = useState(false);
  const [sirenActive, setSirenActive] = useState(false);
  const [presetAdding, setPresetAdding] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);

  useEffect(() => {
    setCap(null);
    setSimPanOffset({ x: 0, y: 0 });
    setSirenActive(false);
    setPresetAdding(false);
    setNewPresetName("");

    if (!online) return;
    if (isSim) {
      setCap({
        deviceId: camera.deviceId,
        online: telemetry?.status !== "offline",
        privacyOn: false,
        ptzSupported: true,
        sdStatus: "ready",
        sdCard: {
          status: "normal",
          totalSpace: "58.2 GB",
          freeSpace: "41.6 GB",
          percent: 71,
          loopRecordEnabled: true,
        },
        micVolume: 80,
        speakerVolume: 70,
        alarmEnabled: false,
        presets: [
          { id: "1", name: "Вход" },
          { id: "2", name: "Касса" },
        ],
        lastCheckedAt: Date.now(),
      });
      return;
    }
    let cancelled = false;
    setCapLoading(true);

    void api<CameraCapabilitySnapshot>(
      `/api/cameras/${encodeURIComponent(camera.deviceId)}/capabilities`,
    )
      .then((snap) => {
        if (!cancelled) setCap(snap);
      })
      .catch(() => {
        if (!cancelled) setCap(null);
      })
      .finally(() => {
        if (!cancelled) setCapLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [camera.deviceId, online]);

  const effectiveOnline = cap ? cap.online : online;
  const statusMeta = relayStatusMeta(effectiveOnline ? telemetry?.status : "offline", lang);

  async function refreshCapabilities() {
    if (isSim) return;
    setCapLoading(true);
    try {
      const snap = await api<CameraCapabilitySnapshot>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/capabilities`,
      );
      setCap(snap);
    } catch (err) {
      toastManager.add({
        title: t("toastCameraCheckFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setCapLoading(false);
    }
  }

  function handleSettingsSynced(snap: CameraSettingsSnapshot) {
    if (snap.alarm.sirenStatus) {
      setSirenActive(snap.alarm.sirenStatus === "on");
    }
    setCap((prev) =>
      prev
        ? {
            ...prev,
            speakerVolume: snap.speakerVolume,
            micVolume: snap.micVolume,
            micMuted: snap.micMuted,
            alarmEnabled: snap.alarm.supported ? snap.alarm.enabled : prev.alarmEnabled,
            presets: snap.presets,
            sdCard: snap.sdCard ?? prev.sdCard,
          }
        : prev,
    );
  }

  async function movePtz(dx: number, dy: number) {
    if (ptzBusy) return;
    const step = Number(ptzStep) || 10;
    const sign = camera.orientation?.invertPtz ? -1 : 1;
    const effDx = dx * sign;
    const effDy = dy * sign;
    if (isSim) {
      setSimPanOffset((prev) => ({
        x: Math.max(-60, Math.min(60, prev.x - effDx * step)),
        y: Math.max(-35, Math.min(35, prev.y + effDy * step)),
      }));
      return;
    }
    setPtzBusy(true);
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.deviceId)}/ptz`, {
        method: "POST",
        body: JSON.stringify({ x: effDx * step, y: effDy * step }),
      });
    } catch (err) {
      toastManager.add({
        title: t("toastPtzFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setPtzBusy(false);
    }
  }

  async function confirmPrivacyChange() {
    if (isSim) {
      setCap((prev) => (prev ? { ...prev, privacyOn: pendingPrivacyTarget } : prev));
      setPrivacyDialogOpen(false);
      toastManager.add({
        title: pendingPrivacyTarget ? t("toastSimLensClosed") : t("toastSimLensOpened"),
        type: pendingPrivacyTarget ? "warning" : "success",
      });
      return;
    }
    setPrivacySaving(true);
    try {
      const res = await api<{ privacyOn: boolean }>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/privacy`,
        {
          method: "POST",
          body: JSON.stringify({ enabled: pendingPrivacyTarget }),
        },
      );
      setCap((prev) => (prev ? { ...prev, privacyOn: res.privacyOn } : prev));
      setPrivacyDialogOpen(false);
      toastManager.add({
        title: res.privacyOn ? t("toastPrivacyEnabled") : t("toastLensOpened"),
        description: label,
        type: res.privacyOn ? "warning" : "success",
      });
    } catch (err) {
      toastManager.add({
        title: t("toastPrivacyFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setPrivacySaving(false);
    }
  }

  async function setCameraMicVolume(vol: number) {
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.deviceId)}/audio-config`, {
        method: "POST",
        body: JSON.stringify({ micVolume: vol, micMuted: false }),
      });
      setCap((prev) => (prev ? { ...prev, micVolume: vol, micMuted: false } : prev));
      toastManager.add({ title: t("toastMicGainUpdated", { vol }), type: "success" });
    } catch (err) {
      toastManager.add({
        title: t("toastMicGainFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    }
  }

  async function toggleAutoAlarm(enabled: boolean) {
    if (isSim) {
      setCap((prev) => (prev ? { ...prev, alarmEnabled: enabled } : prev));
      toastManager.add({
        title: enabled ? t("toastAlarmEnabled") : t("toastAlarmDisabled"),
        type: enabled ? "warning" : "info",
      });
      return;
    }
    setAlarmBusy(true);
    try {
      const snap = await api<CameraSettingsSnapshot>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/settings`,
        {
          method: "PATCH",
          body: JSON.stringify({ alarm: { enabled } }),
        },
      );
      handleSettingsSynced(snap);
      toastManager.add({
        title: snap.alarm.enabled ? t("toastAlarmEnabled") : t("toastAlarmDisabled"),
        type: snap.alarm.enabled ? "warning" : "info",
      });
    } catch (err) {
      toastManager.add({
        title: t("toastAlarmFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setAlarmBusy(false);
    }
  }

  async function toggleManualSiren() {
    const nextAction = sirenActive ? "stop" : "start";
    if (isSim) {
      setSirenActive(nextAction === "start");
      toastManager.add({
        title: nextAction === "start" ? t("toastSirenStarted") : t("toastSirenStopped"),
        type: nextAction === "start" ? "warning" : "info",
      });
      return;
    }
    setSirenBusy(true);
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.deviceId)}/alarm/manual`, {
        method: "POST",
        body: JSON.stringify({ action: nextAction }),
      });
      setSirenActive(nextAction === "start");
      toastManager.add({
        title: nextAction === "start" ? t("toastSirenStarted") : t("toastSirenStopped"),
        type: nextAction === "start" ? "warning" : "info",
      });
    } catch (err) {
      toastManager.add({
        title: t("toastSirenFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setSirenBusy(false);
    }
  }

  async function goToPreset(preset: CameraPreset) {
    if (isSim) {
      setSimPanOffset((prev) => ({
        x: preset.id === "1" ? -25 : 25,
        y: prev.y,
      }));
      toastManager.add({ title: t("toastPresetMoved", { name: preset.name }), type: "info" });
      return;
    }
    setPresetBusy(true);
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.deviceId)}/ptz/presets`, {
        method: "POST",
        body: JSON.stringify({ action: "goto", id: preset.id }),
      });
      toastManager.add({ title: t("toastPresetMoved", { name: preset.name }), type: "success" });
    } catch (err) {
      toastManager.add({
        title: t("toastPresetFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setPresetBusy(false);
    }
  }

  async function saveNewPreset(e: React.FormEvent) {
    e.preventDefault();
    const clean = newPresetName.trim();
    if (!clean) return;
    if (isSim) {
      const next: CameraPreset = { id: String(Date.now()), name: clean };
      setCap((prev) =>
        prev ? { ...prev, presets: [...(prev.presets ?? []), next] } : prev,
      );
      setNewPresetName("");
      setPresetAdding(false);
      toastManager.add({ title: t("toastPresetSaved", { name: clean }), type: "success" });
      return;
    }
    setPresetBusy(true);
    try {
      const res = await api<{ presets: CameraPreset[] }>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/ptz/presets`,
        {
          method: "POST",
          body: JSON.stringify({ action: "save", name: clean }),
        },
      );
      setCap((prev) => (prev ? { ...prev, presets: res.presets } : prev));
      setNewPresetName("");
      setPresetAdding(false);
      toastManager.add({ title: t("toastPresetSaved", { name: clean }), type: "success" });
    } catch (err) {
      toastManager.add({
        title: t("toastPresetFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setPresetBusy(false);
    }
  }

  async function deletePreset(presetId: string) {
    if (isSim) {
      setCap((prev) =>
        prev
          ? { ...prev, presets: (prev.presets ?? []).filter((p) => p.id !== presetId) }
          : prev,
      );
      toastManager.add({ title: t("toastPresetDeleted"), type: "info" });
      return;
    }
    setPresetBusy(true);
    try {
      const res = await api<{ presets: CameraPreset[] }>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/ptz/presets`,
        {
          method: "POST",
          body: JSON.stringify({ action: "delete", id: presetId }),
        },
      );
      setCap((prev) => (prev ? { ...prev, presets: res.presets } : prev));
      toastManager.add({ title: t("toastPresetDeleted"), type: "info" });
    } catch (err) {
      toastManager.add({
        title: t("toastPresetFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setPresetBusy(false);
    }
  }

  return (
    <div className="flex h-full w-full flex-col gap-3">
      {/* Compact Focus Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button onClick={onExitFocus} size="sm" variant="outline">
            <ArrowLeftIcon aria-hidden="true" />
            <span>{t("backToGrid")}</span>
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn("size-2 shrink-0 rounded-full", statusMeta.dotClass)}
              title={statusMeta.label}
            />
            <h2 className="truncate text-sm font-semibold">{label}</h2>
            {storeName && (
              <Badge className="hidden sm:inline-flex" variant="outline">
                {storeName}
              </Badge>
            )}
            <Button
              aria-label={t("editCameraOrStoreAria")}
              onClick={() => onEditCamera(camera)}
              size="icon-xs"
              variant="ghost"
            >
              <PencilIcon aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <SegmentedControl
            aria-label={t("focusModePlayback")}
            render={
              <RadioGroupPrimitive
                onValueChange={(v) => setStageMode(v as "live" | "playback")}
                value={stageMode}
              />
            }
            size="sm"
          >
            <SegmentedControlItem render={<RadioPrimitive.Root value="live" />}>
              <RadioIcon aria-hidden="true" className="size-3.5" />
              <span>{t("focusModeLive")}</span>
            </SegmentedControlItem>
            <SegmentedControlItem render={<RadioPrimitive.Root value="playback" />}>
              <HardDriveIcon aria-hidden="true" className="size-3.5" />
              <span>{t("focusModePlayback")}</span>
            </SegmentedControlItem>
          </SegmentedControl>

          <Button
            aria-pressed={Boolean(camera.orientation?.rotate180)}
            onClick={() => {
              const nextRotate = !camera.orientation?.rotate180;
              void onUpdateOrientation(camera.deviceId, {
                rotate180: nextRotate,
                invertPtz: nextRotate,
              });
            }}
            size="sm"
            title={t("cameraOrientationRotate180Label")}
            variant={camera.orientation?.rotate180 ? "secondary" : "outline"}
          >
            <RotateCwIcon aria-hidden="true" />
            <span>{t("flip180Button")}</span>
          </Button>
          {cameras.length > 1 && (
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={t("prevCameraAria")}
                      onClick={() => onStepCamera(-1)}
                      size="icon-sm"
                      variant="outline"
                    />
                  }
                >
                  <ChevronLeftIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup>{t("prevCameraTooltip")}</TooltipPopup>
              </Tooltip>

              {settings.autoCycleSeconds > 0 && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label={autoCyclePaused ? t("resumeCycleAria") : t("pauseCycleAria")}
                        onClick={onToggleAutoCyclePause}
                        size="icon-sm"
                        variant="outline"
                      />
                    }
                  >
                    {autoCyclePaused ? (
                      <PlayIcon aria-hidden="true" />
                    ) : (
                      <PauseIcon aria-hidden="true" />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {autoCyclePaused ? t("resumeCycleTooltip") : t("pauseCycleTooltip")}
                  </TooltipPopup>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={t("nextCameraAria")}
                      onClick={() => onStepCamera(1)}
                      size="icon-sm"
                      variant="outline"
                    />
                  }
                >
                  <ChevronRightIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup>{t("nextCameraTooltip")}</TooltipPopup>
              </Tooltip>
            </div>
          )}
        </div>
      </div>

      {/* Main Camera View: dedicated SD Playback Workspace OR Live HD stage + control dock */}
      {stageMode === "playback" ? (
        <CameraArchivePanel
          camera={camera}
          cap={cap}
          capLoading={capLoading}
          isSim={isSim}
          media={media}
          mediaDir={mediaDir}
          onDeleteMedia={onDeleteMedia}
          onMediaSaved={onMediaSaved}
          onOpenGallery={onOpenGallery}
          onRefreshCap={() => void refreshCapabilities()}
          online={effectiveOnline}
        />
      ) : (
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-2xl border bg-black shadow-lg">
          <VideoStreamStage
            className="h-full w-full aspect-auto"
            deviceId={camera.deviceId}
            lastError={telemetry?.lastError}
            mirrorDeviceId={camera.mirrorSourceDeviceId}
            online={camera.accessPlatform === "IOT" || online}
            panOffset={isSim ? simPanOffset : undefined}
            quality="hd"
            rotate180={Boolean(camera.orientation?.rotate180)}
            targetFps={30}
            telemetryStatus={telemetry?.status}
            transport={settings.gridTransport}
          />
        </div>

        {/* Always-visible inline camera controls & C200 settings */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardPanel className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
            <Tabs
              className="flex min-h-0 flex-1 flex-col gap-3"
              onValueChange={(v) => setPanelTab(v as "control" | "settings")}
              value={panelTab}
            >
              <TabsList className="w-full shrink-0">
                <TabsTab className="flex-1 text-xs" value="control">
                  {t("tabControl")}
                </TabsTab>
                <TabsTab className="flex-1 text-xs" value="settings">
                  {t("tabSettings")}
                </TabsTab>
              </TabsList>

              <TabsPanel className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5" value="control">
                {/* Audio Listen & Two-Way Talk */}
                <div className="flex flex-col gap-2 rounded-xl border bg-muted/20 p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      aria-pressed={audio.listening}
                      disabled={!effectiveOnline || isSim}
                      onClick={audio.toggle}
                      size="sm"
                      variant={audio.listening ? "default" : "outline"}
                    >
                      {audio.listening ? (
                        <Volume2Icon aria-hidden="true" />
                      ) : (
                        <VolumeXIcon aria-hidden="true" />
                      )}
                      <span>
                        {audio.connecting
                          ? t("soundConnecting")
                          : audio.listening
                            ? t("soundOn")
                            : t("soundOff")}
                      </span>
                    </Button>

                    <Button
                      aria-pressed={talk.state === "live" || talk.state === "connecting"}
                      disabled={!effectiveOnline || isSim}
                      onClick={talk.toggle}
                      size="sm"
                      variant={
                        talk.state === "live"
                          ? "destructive"
                          : talk.state === "connecting"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {talk.state === "live" || talk.state === "connecting" ? (
                        <MicIcon aria-hidden="true" />
                      ) : (
                        <MicOffIcon aria-hidden="true" />
                      )}
                      <span>
                        {talk.state === "connecting"
                          ? t("talkConnecting")
                          : talk.state === "live"
                            ? t("talkLive")
                            : t("talkIdle")}
                      </span>
                    </Button>
                  </div>

                  {audio.listening && (
                    <div className="flex flex-col gap-1.5 pt-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>{t("audioGainLabel")}</span>
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-emerald-500 transition-[width] duration-75"
                            style={{ width: `${Math.round(audio.level * 100)}%` }}
                          />
                        </div>
                      </div>
                      <SegmentedControl
                        aria-label={t("audioGainLabel")}
                        className="w-full"
                        render={
                          <RadioGroupPrimitive
                            onValueChange={(v) => audio.setGain(Number(v))}
                            value={String(audio.gain)}
                          />
                        }
                        size="sm"
                      >
                        {GAIN_STEPS.map((g) => (
                          <SegmentedControlItem
                            className="grow tabular-nums"
                            key={g.value}
                            render={<RadioPrimitive.Root value={g.value} />}
                          >
                            {g.label}
                          </SegmentedControlItem>
                        ))}
                      </SegmentedControl>
                    </div>
                  )}

                  {talk.state === "live" && (
                    <div className="flex items-center justify-between gap-2 text-[11px] text-emerald-400">
                      <span>{t("micOpenSpeak")}</span>
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-emerald-400 transition-[width] duration-75"
                          style={{ width: `${Math.round(talk.micLevel * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {talk.error && (
                    <p className="text-[11px] text-destructive-foreground">{talk.error}</p>
                  )}

                  {cap && (cap.micVolume === 0 || cap.micMuted) && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px]">
                      <span>{t("cameraMicZero")}</span>
                      <Button onClick={() => void setCameraMicVolume(80)} size="xs" variant="outline">
                        {t("enable80Pct")}
                      </Button>
                    </div>
                  )}
                </div>

                {/* Alarm Mode & Manual Siren */}
                <div className="flex flex-col gap-2 rounded-xl border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      {cap?.alarmEnabled ? (
                        <BellRingIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />
                      ) : (
                        <BellOffIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      )}
                      <span>{t("alarmSectionTitle")}</span>
                    </div>
                    <Badge size="sm" variant={cap?.alarmEnabled ? "warning" : "secondary"}>
                      {cap?.alarmEnabled ? t("alarmActive") : t("alarmInactive")}
                    </Badge>
                  </div>

                  <label className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{t("alarmAutoLabel")}</span>
                    <Switch
                      checked={Boolean(cap?.alarmEnabled)}
                      disabled={!effectiveOnline || alarmBusy || capLoading}
                      onCheckedChange={(checked) => void toggleAutoAlarm(checked)}
                    />
                  </label>

                  <Button
                    disabled={!effectiveOnline || sirenBusy}
                    loading={sirenBusy}
                    onClick={() => void toggleManualSiren()}
                    size="xs"
                    variant={sirenActive ? "destructive" : "outline"}
                  >
                    <SirenIcon aria-hidden="true" />
                    <span>{sirenActive ? t("alarmStopSiren") : t("alarmTriggerSiren")}</span>
                  </Button>
                </div>

                {/* Capture to Server Gallery */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    disabled={!effectiveOnline || capturingSnap}
                    loading={capturingSnap}
                    onClick={() => {
                      setCapturingSnap(true);
                      void onSnapshot(camera.deviceId).finally(() => setCapturingSnap(false));
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <CameraIcon aria-hidden="true" />
                    <span>{t("captureSnapshot")}</span>
                  </Button>
                  <Button
                    disabled={!effectiveOnline || capturingClip}
                    loading={capturingClip}
                    onClick={() => {
                      setCapturingClip(true);
                      void onClipSave(camera.deviceId).finally(() => setCapturingClip(false));
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <FilmIcon aria-hidden="true" />
                    <span>{t("captureClipMp4")}</span>
                  </Button>
                </div>

                {/* PTZ Pan/Tilt & Presets Section */}
                <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <RotateCwIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      <span>{t("ptzTitle")}</span>
                      {camera.orientation?.invertPtz && (
                        <Badge size="sm" variant="secondary">
                          {t("ptzInvertedBadge")}
                        </Badge>
                      )}
                    </div>
                    {(ptzBusy || presetBusy) && <Spinner className="size-3.5" />}
                  </div>

                  {!effectiveOnline ? (
                    <p className="text-xs text-muted-foreground">{t("cameraOfflineNote")}</p>
                  ) : cap?.ptzSupported === false ? (
                    <p className="text-xs text-muted-foreground">{t("ptzUnsupported")}</p>
                  ) : (
                    <>
                      <div className="mx-auto grid grid-cols-3 gap-1.5">
                        <div />
                        <Button
                          aria-label={t("ptzUpAria")}
                          disabled={ptzBusy}
                          onClick={() => void movePtz(0, 1)}
                          size="icon-sm"
                          variant="outline"
                        >
                          <ArrowUpIcon aria-hidden="true" />
                        </Button>
                        <div />
                        <Button
                          aria-label={t("ptzLeftAria")}
                          disabled={ptzBusy}
                          onClick={() => void movePtz(-1, 0)}
                          size="icon-sm"
                          variant="outline"
                        >
                          <ArrowLeftIcon aria-hidden="true" />
                        </Button>
                        <div className="flex items-center justify-center rounded-lg border border-dashed text-[11px] font-medium text-muted-foreground tabular-nums">
                          {ptzStep}°
                        </div>
                        <Button
                          aria-label={t("ptzRightAria")}
                          disabled={ptzBusy}
                          onClick={() => void movePtz(1, 0)}
                          size="icon-sm"
                          variant="outline"
                        >
                          <ArrowRightIcon aria-hidden="true" />
                        </Button>
                        <div />
                        <Button
                          aria-label={t("ptzDownAria")}
                          disabled={ptzBusy}
                          onClick={() => void movePtz(0, -1)}
                          size="icon-sm"
                          variant="outline"
                        >
                          <ArrowDownIcon aria-hidden="true" />
                        </Button>
                        <div />
                      </div>

                      <SegmentedControl
                        aria-label={t("ptzStepAria")}
                        className="w-full"
                        render={
                          <RadioGroupPrimitive
                            onValueChange={(v) => setPtzStep(String(v))}
                            value={ptzStep}
                          />
                        }
                        size="sm"
                      >
                        {PTZ_STEPS.map((step) => (
                          <SegmentedControlItem
                            className="grow tabular-nums"
                            key={step.value}
                            render={<RadioPrimitive.Root value={step.value} />}
                          >
                            {step.label}
                          </SegmentedControlItem>
                        ))}
                      </SegmentedControl>

                      {/* PTZ Presets */}
                      <div className="flex flex-col gap-1.5 border-t pt-2">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <MapPinIcon aria-hidden="true" className="size-3" />
                            <span>{t("presetsTitle")}</span>
                          </div>
                          <Button
                            onClick={() => setPresetAdding((v) => !v)}
                            size="xs"
                            variant="ghost"
                          >
                            <PlusIcon aria-hidden="true" />
                            <span>{t("presetSaveCurrent")}</span>
                          </Button>
                        </div>

                        {presetAdding && (
                          <form className="flex items-center gap-1" onSubmit={(e) => void saveNewPreset(e)}>
                            <Input
                              className="h-7 flex-1 text-xs"
                              onChange={(e) => setNewPresetName(e.target.value)}
                              placeholder={t("presetNamePlaceholder")}
                              value={newPresetName}
                            />
                            <Button
                              disabled={presetBusy || !newPresetName.trim()}
                              size="xs"
                              type="submit"
                            >
                              {t("save")}
                            </Button>
                          </form>
                        )}

                        {cap?.presets && cap.presets.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {cap.presets.map((preset) => (
                              <div
                                className="inline-flex items-center rounded-md border bg-background/80"
                                key={preset.id}
                              >
                                <Button
                                  aria-label={t("presetGoAria", { name: preset.name })}
                                  className="h-6 rounded-r-none border-0 px-2 text-[11px]"
                                  disabled={presetBusy}
                                  onClick={() => void goToPreset(preset)}
                                  size="xs"
                                  variant="ghost"
                                >
                                  {preset.name}
                                </Button>
                                <button
                                  aria-label={t("presetDeleteAria", { name: preset.name })}
                                  className="flex h-6 items-center px-1 text-muted-foreground hover:text-destructive-foreground"
                                  disabled={presetBusy}
                                  onClick={() => void deletePreset(preset.id)}
                                  type="button"
                                >
                                  <XIcon aria-hidden="true" className="size-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          !presetAdding && (
                            <p className="text-[11px] text-muted-foreground">{t("presetEmpty")}</p>
                          )
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Privacy Mode */}
                <div className="flex flex-col gap-2 rounded-xl border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      {cap?.privacyOn ? (
                        <EyeOffIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />
                      ) : (
                        <EyeIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      )}
                      <span>{t("privacyTitle")}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {capLoading ? (
                        <Spinner className="size-3" />
                      ) : cap?.privacyOn === true ? (
                        <Badge size="sm" variant="warning">
                          {t("privacyClosed")}
                        </Badge>
                      ) : cap?.privacyOn === false ? (
                        <Badge size="sm" variant="success">
                          {t("privacyOpen")}
                        </Badge>
                      ) : (
                        <Badge size="sm" variant="secondary">
                          —
                        </Badge>
                      )}
                      <Button
                        aria-label={t("refreshStatusAria")}
                        disabled={!effectiveOnline || capLoading}
                        onClick={() => void refreshCapabilities()}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <RefreshCwIcon aria-hidden="true" />
                      </Button>
                    </div>
                  </div>

                  <Button
                    disabled={!effectiveOnline || capLoading}
                    onClick={() => {
                      setPendingPrivacyTarget(!(cap?.privacyOn ?? false));
                      setPrivacyDialogOpen(true);
                    }}
                    size="xs"
                    variant={cap?.privacyOn ? "default" : "destructive-outline"}
                  >
                    {cap?.privacyOn ? t("openLens") : t("closeLensEllipsis")}
                  </Button>
                </div>
              </TabsPanel>

              <TabsPanel className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5" value="settings">
                <CameraSettingsPanel
                  camera={camera}
                  isSim={isSim}
                  onSettingsLoaded={handleSettingsSynced}
                  onUpdateOrientation={onUpdateOrientation}
                  online={effectiveOnline}
                />
              </TabsPanel>
            </Tabs>
          </CardPanel>
        </Card>
      </div>
      )}

      {/* Quick switcher strip when more than one camera */}
      {cameras.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {cameras.map((cam) => {
            const active = cam.deviceId === camera.deviceId;
            return (
              <Button
                className="shrink-0"
                key={cam.deviceId}
                onClick={() => onSelectCamera(cam.deviceId)}
                size="xs"
                variant={active ? "default" : "outline"}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    isCameraOnline(cam, telemetryMap[cam.deviceId])
                      ? "bg-emerald-500"
                      : "bg-red-500",
                  )}
                />
                <span className="max-w-36 truncate">{cameraLabel(cam)}</span>
              </Button>
            );
          })}
        </div>
      )}

      <AlertDialog onOpenChange={setPrivacyDialogOpen} open={privacyDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingPrivacyTarget
                ? t("privacyDialogEnableTitle")
                : t("privacyDialogDisableTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingPrivacyTarget
                ? t("privacyDialogEnableDesc", { label })
                : t("privacyDialogDisableDesc", { label })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button disabled={privacySaving} variant="ghost" />}>
              {t("cancel")}
            </AlertDialogClose>
            <Button
              disabled={privacySaving}
              loading={privacySaving}
              onClick={() => void confirmPrivacyChange()}
              variant={pendingPrivacyTarget ? "destructive" : "default"}
            >
              {pendingPrivacyTarget
                ? t("privacyDialogEnableAction")
                : t("privacyDialogDisableAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
