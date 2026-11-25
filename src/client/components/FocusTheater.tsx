import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CalendarIcon,
  CameraIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FilmIcon,
  HardDriveIcon,
  MicIcon,
  MicOffIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { api, cameraLabel, formatDuration, isCameraOnline, relayStatusMeta, todayIsoDate } from "@/lib/api";
import { useCameraAudio, useCameraTalk } from "@/lib/audio";
import { isSimulatedCamera } from "@/lib/debug-emulator";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  CameraCapabilitySnapshot,
  CameraMeta,
  CameraTelemetry,
  DashboardSettings,
  RecordingClip,
  RecordingDayResponse,
} from "../../shared/types";

interface FocusTheaterProps {
  camera: CameraMeta;
  cameras: CameraMeta[];
  storeName?: string;
  telemetryMap: Record<string, CameraTelemetry>;
  settings: DashboardSettings;
  autoCyclePaused: boolean;
  onToggleAutoCyclePause: () => void;
  onSelectCamera: (deviceId: string) => void;
  onStepCamera: (dir: -1 | 1) => void;
  onExitFocus: () => void;
  onEditCamera: (camera: CameraMeta) => void;
  onSnapshot: (deviceId: string) => Promise<void>;
  onClipSave: (deviceId: string) => Promise<void>;
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
  autoCyclePaused,
  onToggleAutoCyclePause,
  onSelectCamera,
  onStepCamera,
  onExitFocus,
  onEditCamera,
  onSnapshot,
  onClipSave,
}: FocusTheaterProps): React.ReactElement {
  const { lang, t } = useI18n();
  const telemetry = telemetryMap[camera.deviceId];
  const online = isCameraOnline(camera, telemetry);
  const label = cameraLabel(camera);
  const isSim = isSimulatedCamera(camera.deviceId);

  const audio = useCameraAudio(camera.deviceId, online && !isSim);
  const talk = useCameraTalk(camera.deviceId, online && !isSim);

  const [panelTab, setPanelTab] = useState<"control" | "archive">("control");
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

  const [days, setDays] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());
  const [recordings, setRecordings] = useState<RecordingClip[]>([]);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [playingClip, setPlayingClip] = useState<RecordingClip | null>(null);

  useEffect(() => {
    setCap(null);
    setPlayingClip(null);
    setRecordings([]);
    setRecError(null);
    setDays([]);
    setSimPanOffset({ x: 0, y: 0 });

    if (!online) return;
    if (isSim) {
      setCap({
        deviceId: camera.deviceId,
        online: telemetry?.status !== "offline",
        privacyOn: false,
        ptzSupported: true,
        sdStatus: "missing_or_unformatted",
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
        if (cancelled) return;
        setCap(snap);
        if (snap.sdStatus === "ready") {
          void api<{ days: string[] }>(
            `/api/cameras/${encodeURIComponent(camera.deviceId)}/recordings/days`,
          )
            .then((res) => {
              if (!cancelled) {
                setDays(res.days ?? []);
                const latest = res.days?.[res.days.length - 1];
                if (latest) setSelectedDate(latest);
              }
            })
            .catch(() => {
              if (!cancelled) setDays([]);
            });
        }
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

  useEffect(() => {
    if (panelTab !== "archive" || !online) return;
    if (cap && cap.sdStatus === "missing_or_unformatted") {
      setRecordings([]);
      setRecError(null);
      return;
    }
    if (capLoading) return;
    void loadDayRecordings(camera.deviceId, selectedDate);
  }, [panelTab, camera.deviceId, selectedDate, online, cap?.sdStatus, capLoading]);

  const effectiveOnline = cap ? cap.online : online;
  const statusMeta = relayStatusMeta(effectiveOnline ? telemetry?.status : "offline", lang);

  async function refreshCapabilities() {
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

  async function loadDayRecordings(deviceId: string, date: string) {
    setRecLoading(true);
    setRecError(null);
    try {
      const res = await api<RecordingDayResponse>(
        `/api/cameras/${encodeURIComponent(deviceId)}/recordings?date=${encodeURIComponent(date)}`,
      );
      setRecordings(res.clips ?? []);
    } catch (err) {
      setRecordings([]);
      setRecError(err instanceof Error ? err.message : t("archiveLoadError"));
    } finally {
      setRecLoading(false);
    }
  }

  async function movePtz(dx: number, dy: number) {
    if (ptzBusy) return;
    const step = Number(ptzStep) || 10;
    if (isSim) {
      setSimPanOffset((prev) => ({
        x: Math.max(-60, Math.min(60, prev.x - dx * step)),
        y: Math.max(-35, Math.min(35, prev.y + dy * step)),
      }));
      return;
    }
    setPtzBusy(true);
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.deviceId)}/ptz`, {
        method: "POST",
        body: JSON.stringify({ x: dx * step, y: dy * step }),
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

  const playbackUrl = playingClip
    ? `/api/cameras/${encodeURIComponent(camera.deviceId)}/recordings/play?start=${playingClip.start}&end=${playingClip.end}`
    : "";

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

      {/* Main Camera View: full-bleed HD stage + always-visible control dock */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-2xl border bg-black shadow-lg">
          <VideoStreamStage
            className="h-full w-full aspect-auto"
            deviceId={camera.deviceId}
            lastError={telemetry?.lastError}
            online={camera.accessPlatform === "IOT" || online}
            panOffset={isSim ? simPanOffset : undefined}
            quality="hd"
            targetFps={30}
            telemetryStatus={telemetry?.status}
            transport={settings.gridTransport}
          />
        </div>

        {/* Always-visible inline camera controls & SD archive (never hidden in a drawer) */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardPanel className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
            <Tabs
              className="flex min-h-0 flex-1 flex-col gap-3"
              onValueChange={(v) => setPanelTab(v as "control" | "archive")}
              value={panelTab}
            >
              <TabsList className="w-full shrink-0">
                <TabsTab className="flex-1" value="control">
                  {t("tabControl")}
                </TabsTab>
                <TabsTab className="flex-1" value="archive">
                  {t("tabArchive")}
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

                {/* PTZ Pan/Tilt Section */}
                <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <RotateCwIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      <span>{t("ptzTitle")}</span>
                    </div>
                    {ptzBusy && <Spinner className="size-3.5" />}
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

              <TabsPanel className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5" value="archive">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <HardDriveIcon aria-hidden="true" className="size-3.5" />
                    <span>
                      {cap?.sdStatus === "missing_or_unformatted"
                        ? t("sdMissing")
                        : cap?.sdStatus === "ready"
                          ? t("sdReady")
                          : t("sdArchiveTitle")}
                    </span>
                  </div>

                  {cap?.sdStatus !== "missing_or_unformatted" && (
                    <div className="flex items-center gap-1">
                      <CalendarIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      <Input
                        className="h-7 w-32 text-xs"
                        onChange={(e) => setSelectedDate(e.target.value)}
                        type="date"
                        value={selectedDate}
                      />
                      <Button
                        aria-label={t("refreshStatusAria")}
                        disabled={!effectiveOnline || recLoading}
                        onClick={() => void loadDayRecordings(camera.deviceId, selectedDate)}
                        size="icon-xs"
                        variant="outline"
                      >
                        <RefreshCwIcon aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </div>

                {cap?.sdStatus === "missing_or_unformatted" ? (
                  <div className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
                    {t("sdMissingNote")}
                  </div>
                ) : (
                  <>
                    {days.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {days.slice(-6).map((day) => (
                          <Button
                            key={day}
                            onClick={() => setSelectedDate(day)}
                            size="xs"
                            variant={selectedDate === day ? "default" : "outline"}
                          >
                            {day.slice(5)}
                          </Button>
                        ))}
                      </div>
                    )}

                    {playingClip && (
                      <div className="flex flex-col gap-2 rounded-xl border bg-muted/20 p-2.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium tabular-nums">
                            {playingClip.startLocal} — {playingClip.endLocal}
                          </span>
                          <Button
                            aria-label={t("download")}
                            render={
                              <a
                                download={`tapo-${playingClip.start}.mp4`}
                                href={`${playbackUrl}&download=1`}
                              />
                            }
                            size="xs"
                            variant="outline"
                          >
                            <DownloadIcon aria-hidden="true" />
                          </Button>
                        </div>
                        <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
                          <video
                            autoPlay
                            className="size-full object-contain"
                            controls
                            key={playbackUrl}
                            src={playbackUrl}
                          />
                        </div>
                      </div>
                    )}

                    {recLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                        <Spinner className="size-4" />
                        <span>{t("loadingRecordings")}</span>
                      </div>
                    ) : recError ? (
                      <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                        {recError}
                      </p>
                    ) : recordings.length === 0 ? (
                      <p className="py-6 text-center text-xs text-muted-foreground">
                        {t("noRecordingsForDate")}
                      </p>
                    ) : (
                      <ScrollArea className="min-h-48 flex-1 rounded-xl border">
                        <div className="flex flex-col divide-y">
                          {recordings.map((clip) => {
                            const active = playingClip?.start === clip.start;
                            return (
                              <div
                                className={cn(
                                  "flex items-center justify-between gap-2 px-3 py-2 text-xs",
                                  active && "bg-accent/60",
                                )}
                                key={`${clip.start}-${clip.end}`}
                              >
                                <div className="flex min-w-0 flex-col">
                                  <span className="font-medium tabular-nums">
                                    {clip.startLocal} — {clip.endLocal}
                                  </span>
                                  <span className="text-muted-foreground tabular-nums">
                                    {formatDuration(clip.duration, lang)}
                                  </span>
                                </div>
                                <Button
                                  onClick={() => setPlayingClip(clip)}
                                  size="xs"
                                  variant={active ? "default" : "outline"}
                                >
                                  <PlayIcon aria-hidden="true" />
                                  <span>{active ? t("clipPlaying") : t("clipWatch")}</span>
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    )}
                  </>
                )}
              </TabsPanel>
            </Tabs>
          </CardPanel>
        </Card>
      </div>

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
