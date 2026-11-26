import {
  BellRingIcon,
  CalendarClockIcon,
  HardDriveIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  Volume2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { api, cameraLabel } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type {
  AlarmVolume,
  CameraMeta,
  CameraOrientation,
  CameraSettingsPatch,
  CameraSettingsSnapshot,
  DayNightMode,
  DetectionSensitivity,
  RebootScheduleDay,
  RecordPlanDayKey,
  RecordPlanSegment,
} from "../../shared/types";

interface CameraSettingsPanelProps {
  camera: CameraMeta;
  online: boolean;
  isSim: boolean;
  onSettingsLoaded?: (snap: CameraSettingsSnapshot) => void;
  onUpdateOrientation?: (deviceId: string, orientation: CameraOrientation) => Promise<void>;
}

const DAY_KEYS: readonly RecordPlanDayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

function buildSimulatedSettings(deviceId: string): CameraSettingsSnapshot {
  const days = {
    monday: [{ start: "0000", end: "2400", mode: 2 as const }],
    tuesday: [{ start: "0000", end: "2400", mode: 2 as const }],
    wednesday: [{ start: "0000", end: "2400", mode: 2 as const }],
    thursday: [{ start: "0000", end: "2400", mode: 2 as const }],
    friday: [{ start: "0000", end: "2400", mode: 2 as const }],
    saturday: [{ start: "0000", end: "2400", mode: 2 as const }],
    sunday: [{ start: "0000", end: "2400", mode: 2 as const }],
  };
  return {
    deviceId,
    online: true,
    speakerVolume: 70,
    micVolume: 80,
    micMuted: false,
    sdCard: {
      status: "normal",
      totalSpace: "58.2 GB",
      freeSpace: "41.6 GB",
      percent: 71,
      loopRecordEnabled: true,
    },
    alarm: {
      supported: true,
      enabled: false,
      alarmMode: ["sound"],
      alarmType: "0",
      alarmVolume: "high",
      alarmDuration: 15,
      sirenTypes: ["Siren", "Tone"],
    },
    rebootSchedule: {
      supported: true,
      enabled: true,
      time: "03:00",
      day: "everyday",
      randomRange: 30,
    },
    recordPlan: {
      supported: true,
      enabled: true,
      days,
    },
    dayNightMode: "auto",
    imageFlip: false,
    ledEnabled: true,
    autoTracking: true,
    motionDetection: { supported: true, enabled: true, sensitivity: "normal" },
    personDetection: { supported: true, enabled: true, sensitivity: "normal" },
    presets: [
      { id: "1", name: "Вход" },
      { id: "2", name: "Касса" },
    ],
    lastCheckedAt: Date.now(),
  };
}

function dayModeSummary(segments: RecordPlanSegment[]): "off" | "1" | "2" {
  if (!segments || segments.length === 0) return "off";
  const hasCont = segments.some((s) => s.mode === 1);
  return hasCont ? "1" : "2";
}

function formatPlanDays(
  mode: 1 | 2 | "workday" | "off",
): Record<RecordPlanDayKey, RecordPlanSegment[]> {
  const make = (segs: RecordPlanSegment[]): Record<RecordPlanDayKey, RecordPlanSegment[]> => ({
    monday: segs.map((s) => ({ ...s })),
    tuesday: segs.map((s) => ({ ...s })),
    wednesday: segs.map((s) => ({ ...s })),
    thursday: segs.map((s) => ({ ...s })),
    friday: segs.map((s) => ({ ...s })),
    saturday: segs.map((s) => ({ ...s })),
    sunday: segs.map((s) => ({ ...s })),
  });
  if (mode === "off") return make([]);
  if (mode === "workday") {
    return make([
      { start: "0000", end: "0800", mode: 1 },
      { start: "0800", end: "2200", mode: 2 },
      { start: "2200", end: "2400", mode: 1 },
    ]);
  }
  return make([{ start: "0000", end: "2400", mode }]);
}

export function CameraSettingsPanel({
  camera,
  online,
  isSim,
  onSettingsLoaded,
  onUpdateOrientation,
}: CameraSettingsPanelProps): React.ReactElement {
  const { t } = useI18n();
  const label = cameraLabel(camera);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orientationSaving, setOrientationSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<CameraSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<CameraSettingsSnapshot | null>(null);

  const [rebootDialogOpen, setRebootDialogOpen] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [calibrating, setCalibrating] = useState(false);

  async function applyOrientation(next: CameraOrientation) {
    if (!onUpdateOrientation || orientationSaving) return;
    setOrientationSaving(true);
    try {
      await onUpdateOrientation(camera.deviceId, next);
    } finally {
      setOrientationSaving(false);
    }
  }

  const rotate180Checked = Boolean(camera.orientation?.rotate180);
  const invertPtzChecked = Boolean(camera.orientation?.invertPtz);

  const orientationCard = onUpdateOrientation ? (
    <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <RotateCwIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span>{t("cameraOrientationSectionTitle")}</span>
      </div>

      <label className="flex items-start justify-between gap-2.5">
        <span className="flex flex-col gap-0.5">
          <span className="text-foreground">{t("cameraOrientationRotate180Label")}</span>
          <span className="text-[11px] leading-snug text-muted-foreground">
            {t("cameraOrientationRotate180Desc")}
          </span>
        </span>
        <Switch
          checked={rotate180Checked}
          disabled={orientationSaving}
          onCheckedChange={(checked) =>
            void applyOrientation({
              rotate180: checked,
              invertPtz: checked,
            })
          }
        />
      </label>

      <label className="flex items-start justify-between gap-2.5 border-t pt-2">
        <span className="flex flex-col gap-0.5">
          <span className="text-foreground">{t("cameraOrientationInvertPtzLabel")}</span>
          <span className="text-[11px] leading-snug text-muted-foreground">
            {t("cameraOrientationInvertPtzDesc")}
          </span>
        </span>
        <Switch
          checked={invertPtzChecked}
          disabled={orientationSaving}
          onCheckedChange={(checked) =>
            void applyOrientation({
              rotate180: rotate180Checked,
              invertPtz: checked,
            })
          }
        />
      </label>
    </div>
  ) : null;

  async function loadSettings() {
    if (!online) return;
    if (isSim) {
      const sim = buildSimulatedSettings(camera.deviceId);
      setBaseline(sim);
      setDraft(sim);
      onSettingsLoaded?.(sim);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const snap = await api<CameraSettingsSnapshot>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/settings`,
      );
      setBaseline(snap);
      setDraft(snap);
      onSettingsLoaded?.(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settingsLoadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setBaseline(null);
    setDraft(null);
    setError(null);
    void loadSettings();
  }, [camera.deviceId, online, isSim]);

  async function handleSave() {
    if (!draft) return;
    if (isSim) {
      setBaseline(draft);
      toastManager.add({ title: t("settingsSavedToast"), type: "success" });
      onSettingsLoaded?.(draft);
      return;
    }
    setSaving(true);
    try {
      const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const patch: CameraSettingsPatch = {};

      if (draft.speakerVolume !== undefined && draft.speakerVolume !== baseline?.speakerVolume) {
        patch.speakerVolume = draft.speakerVolume;
      }
      if (draft.micVolume !== undefined && draft.micVolume !== baseline?.micVolume) {
        patch.micVolume = draft.micVolume;
      }
      if (draft.micMuted !== undefined && draft.micMuted !== baseline?.micMuted) {
        patch.micMuted = draft.micMuted;
      }
      if (
        draft.alarm.supported &&
        (!baseline?.alarm ||
          draft.alarm.enabled !== baseline.alarm.enabled ||
          !sameJson(draft.alarm.alarmMode, baseline.alarm.alarmMode) ||
          draft.alarm.alarmType !== baseline.alarm.alarmType ||
          draft.alarm.alarmVolume !== baseline.alarm.alarmVolume ||
          draft.alarm.alarmDuration !== baseline.alarm.alarmDuration)
      ) {
        patch.alarm = {
          enabled: draft.alarm.enabled,
          alarmMode: draft.alarm.alarmMode,
          alarmType: draft.alarm.alarmType,
          alarmVolume: draft.alarm.alarmVolume,
          alarmDuration: draft.alarm.alarmDuration,
        };
      }
      if (
        draft.rebootSchedule.supported &&
        (!baseline?.rebootSchedule ||
          draft.rebootSchedule.enabled !== baseline.rebootSchedule.enabled ||
          draft.rebootSchedule.time !== baseline.rebootSchedule.time ||
          draft.rebootSchedule.day !== baseline.rebootSchedule.day)
      ) {
        patch.rebootSchedule = {
          enabled: draft.rebootSchedule.enabled,
          time: draft.rebootSchedule.time,
          day: draft.rebootSchedule.day,
        };
      }
      if (
        draft.recordPlan.supported &&
        (!baseline?.recordPlan ||
          draft.recordPlan.enabled !== baseline.recordPlan.enabled ||
          !sameJson(draft.recordPlan.days, baseline.recordPlan.days))
      ) {
        patch.recordPlan = {
          enabled: draft.recordPlan.enabled,
          days: draft.recordPlan.days,
        };
      }
      if (draft.dayNightMode !== undefined && draft.dayNightMode !== baseline?.dayNightMode) {
        patch.dayNightMode = draft.dayNightMode;
      }
      if (draft.imageFlip !== undefined && draft.imageFlip !== baseline?.imageFlip) {
        patch.imageFlip = draft.imageFlip;
      }
      if (draft.ledEnabled !== undefined && draft.ledEnabled !== baseline?.ledEnabled) {
        patch.ledEnabled = draft.ledEnabled;
      }
      if (draft.autoTracking !== undefined && draft.autoTracking !== baseline?.autoTracking) {
        patch.autoTracking = draft.autoTracking;
      }
      if (
        draft.motionDetection?.supported &&
        !sameJson(draft.motionDetection, baseline?.motionDetection)
      ) {
        patch.motionDetection = {
          enabled: draft.motionDetection.enabled,
          sensitivity: draft.motionDetection.sensitivity,
        };
      }
      if (
        draft.personDetection?.supported &&
        !sameJson(draft.personDetection, baseline?.personDetection)
      ) {
        patch.personDetection = {
          enabled: draft.personDetection.enabled,
          sensitivity: draft.personDetection.sensitivity,
        };
      }

      if (Object.keys(patch).length === 0) {
        toastManager.add({ title: t("settingsSavedToast"), type: "success" });
        return;
      }

      const updated = await api<CameraSettingsSnapshot>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/settings`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      setBaseline(updated);
      setDraft(updated);
      onSettingsLoaded?.(updated);
      toastManager.add({ title: t("settingsSavedToast"), type: "success" });
    } catch (err) {
      toastManager.add({
        title: t("settingsSaveError"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  async function confirmReboot() {
    if (isSim) {
      setRebootDialogOpen(false);
      toastManager.add({ title: t("toastRebootSent"), type: "warning" });
      return;
    }
    setRebooting(true);
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.deviceId)}/reboot`, {
        method: "POST",
      });
      setRebootDialogOpen(false);
      toastManager.add({ title: t("toastRebootSent"), description: label, type: "warning" });
    } catch (err) {
      toastManager.add({
        title: t("toastRebootFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setRebooting(false);
    }
  }

  async function handleCalibrate() {
    if (isSim) {
      toastManager.add({ title: t("toastMotorCalibrated"), type: "info" });
      return;
    }
    setCalibrating(true);
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.deviceId)}/ptz/calibrate`, {
        method: "POST",
      });
      toastManager.add({ title: t("toastMotorCalibrated"), type: "success" });
    } catch (err) {
      toastManager.add({
        title: t("toastCalibrateFailed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setCalibrating(false);
    }
  }

  if (!online) {
    return (
      <div className="flex flex-col gap-3 pb-1">
        {orientationCard}
        <p className="py-2 text-xs text-muted-foreground">{t("cameraOfflineNote")}</p>
      </div>
    );
  }

  if (loading && !draft) {
    return (
      <div className="flex flex-col gap-3 pb-1">
        {orientationCard}
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <Spinner className="size-4" />
          <span>{t("settingsLoading")}</span>
        </div>
      </div>
    );
  }

  if (error && !draft) {
    return (
      <div className="flex flex-col gap-3 pb-1">
        {orientationCard}
        <div className="flex flex-col gap-2 rounded-xl border p-3 text-xs text-muted-foreground">
          <p>{error}</p>
          <Button onClick={() => void loadSettings()} size="xs" variant="outline">
            <RefreshCwIcon aria-hidden="true" />
            <span>{t("refreshStatusAria")}</span>
          </Button>
        </div>
      </div>
    );
  }

  if (!draft) {
    return orientationCard ? <div className="flex flex-col gap-3 pb-1">{orientationCard}</div> : <></>;
  }

  const rebootDayItems: Array<{ value: RebootScheduleDay; label: string }> = [
    { value: "everyday", label: t("dayEveryday") },
    { value: "monday", label: t("dayMonday") },
    { value: "tuesday", label: t("dayTuesday") },
    { value: "wednesday", label: t("dayWednesday") },
    { value: "thursday", label: t("dayThursday") },
    { value: "friday", label: t("dayFriday") },
    { value: "saturday", label: t("daySaturday") },
    { value: "sunday", label: t("daySunday") },
  ];

  const dayShortLabels: Record<RecordPlanDayKey, string> = {
    monday: t("dayShortMon"),
    tuesday: t("dayShortTue"),
    wednesday: t("dayShortWed"),
    thursday: t("dayShortThu"),
    friday: t("dayShortFri"),
    saturday: t("dayShortSat"),
    sunday: t("dayShortSun"),
  };

  const sirenDurationItems = [
    { value: "0", label: t("auto") },
    { value: "5", label: t("alarmDurationSec", { n: 5 }) },
    { value: "10", label: t("alarmDurationSec", { n: 10 }) },
    { value: "15", label: t("alarmDurationSec", { n: 15 }) },
    { value: "30", label: t("alarmDurationSec", { n: 30 }) },
  ];

  const sensitivityOptions: Array<{ value: DetectionSensitivity; label: string }> = [
    { value: "low", label: t("sensitivityLow") },
    { value: "normal", label: t("sensitivityNormal") },
    { value: "high", label: t("sensitivityHigh") },
  ];

  return (
    <div className="flex flex-col gap-3 pb-1">
      <div className="flex items-center justify-between gap-2">
        <Button
          disabled={loading}
          onClick={() => void loadSettings()}
          size="xs"
          variant="ghost"
        >
          <RefreshCwIcon aria-hidden="true" />
          <span>{t("refreshStatusAria")}</span>
        </Button>
        <Button
          disabled={saving}
          loading={saving}
          onClick={() => void handleSave()}
          size="xs"
        >
          {t("settingsSaveButton")}
        </Button>
      </div>

      {orientationCard}

      {/* Power & Auto-Reboot */}
      <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <CalendarClockIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>{t("settingsRebootTitle")}</span>
          </div>
          <Button
            onClick={() => setRebootDialogOpen(true)}
            size="xs"
            variant="destructive-outline"
          >
            <PowerIcon aria-hidden="true" />
            <span>{t("rebootNowButton")}</span>
          </Button>
        </div>

        {draft.rebootSchedule.supported && (
          <div className="flex flex-col gap-2 pt-0.5 text-xs">
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("autoRebootEnabled")}</span>
              <Switch
                checked={draft.rebootSchedule.enabled}
                onCheckedChange={(checked) =>
                  setDraft((prev) =>
                    prev
                      ? { ...prev, rebootSchedule: { ...prev.rebootSchedule, enabled: checked } }
                      : prev,
                  )
                }
              />
            </label>

            {draft.rebootSchedule.enabled && (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">{t("autoRebootTime")}</span>
                  <Input
                    className="h-8 text-xs tabular-nums"
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              rebootSchedule: { ...prev.rebootSchedule, time: e.target.value },
                            }
                          : prev,
                      )
                    }
                    type="time"
                    value={draft.rebootSchedule.time}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">{t("autoRebootDay")}</span>
                  <Select
                    items={rebootDayItems}
                    onValueChange={(val) => {
                      if (val) {
                        setDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                rebootSchedule: {
                                  ...prev.rebootSchedule,
                                  day: val as RebootScheduleDay,
                                },
                              }
                            : prev,
                        );
                      }
                    }}
                    value={draft.rebootSchedule.day}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {rebootDayItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Camera Speaker & Mic Volume */}
      {(draft.speakerVolume !== undefined || draft.micVolume !== undefined) && (
        <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <Volume2Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>{t("settingsAudioTitle")}</span>
          </div>

          {draft.speakerVolume !== undefined && (
            <label className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{t("speakerVolumeLabel")}</span>
                <span className="font-mono tabular-nums">{draft.speakerVolume}%</span>
              </div>
              <input
                className="accent-primary h-1.5 w-full cursor-pointer"
                max={100}
                min={0}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev ? { ...prev, speakerVolume: Number(e.target.value) } : prev,
                  )
                }
                step={5}
                type="range"
                value={draft.speakerVolume}
              />
            </label>
          )}

          {draft.micVolume !== undefined && (
            <label className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{t("micVolumeLabel")}</span>
                <span className="font-mono tabular-nums">{draft.micVolume}%</span>
              </div>
              <input
                className="accent-primary h-1.5 w-full cursor-pointer"
                max={100}
                min={0}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev ? { ...prev, micVolume: Number(e.target.value) } : prev,
                  )
                }
                step={5}
                type="range"
                value={draft.micVolume}
              />
            </label>
          )}

          {draft.micMuted !== undefined && (
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("micMutedLabel")}</span>
              <Switch
                checked={draft.micMuted}
                onCheckedChange={(checked) =>
                  setDraft((prev) => (prev ? { ...prev, micMuted: checked } : prev))
                }
              />
            </label>
          )}
        </div>
      )}

      {/* SD Card Recording Schedule */}
      {draft.recordPlan.supported && (
        <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium">
              <HardDriveIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>{t("recordPlanTitle")}</span>
            </div>
            {draft.sdCard?.loopRecordEnabled && (
              <Badge size="sm" variant="secondary">
                {t("sdLoopEnabled")}
              </Badge>
            )}
          </div>

          {draft.sdCard?.freeSpace && draft.sdCard?.totalSpace && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {t("sdSpaceInfo", { free: draft.sdCard.freeSpace, total: draft.sdCard.totalSpace })}
            </span>
          )}

          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t("recordPlanEnabled")}</span>
            <Switch
              checked={draft.recordPlan.enabled}
              onCheckedChange={(checked) =>
                setDraft((prev) =>
                  prev ? { ...prev, recordPlan: { ...prev.recordPlan, enabled: checked } } : prev,
                )
              }
            />
          </label>

          {draft.recordPlan.enabled && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1">
                <Button
                  onClick={() =>
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            recordPlan: { ...prev.recordPlan, days: formatPlanDays(2) },
                          }
                        : prev,
                    )
                  }
                  size="xs"
                  variant="outline"
                >
                  {t("recordPlanPresetEvents24")}
                </Button>
                <Button
                  onClick={() =>
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            recordPlan: { ...prev.recordPlan, days: formatPlanDays(1) },
                          }
                        : prev,
                    )
                  }
                  size="xs"
                  variant="outline"
                >
                  {t("recordPlanPresetContinuous24")}
                </Button>
                <Button
                  onClick={() =>
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            recordPlan: { ...prev.recordPlan, days: formatPlanDays("workday") },
                          }
                        : prev,
                    )
                  }
                  size="xs"
                  variant="outline"
                >
                  {t("recordPlanPresetWorkDay")}
                </Button>
                <Button
                  onClick={() =>
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            recordPlan: { ...prev.recordPlan, days: formatPlanDays("off") },
                          }
                        : prev,
                    )
                  }
                  size="xs"
                  variant="ghost"
                >
                  {t("recordPlanPresetClear")}
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                {DAY_KEYS.map((dayKey) => {
                  const summary = dayModeSummary(draft.recordPlan.days[dayKey]);
                  return (
                    <div className="flex items-center justify-between gap-2" key={dayKey}>
                      <span className="w-7 shrink-0 font-medium text-muted-foreground">
                        {dayShortLabels[dayKey]}
                      </span>
                      <SegmentedControl
                        className="flex-1"
                        render={
                          <RadioGroupPrimitive
                            onValueChange={(val) => {
                              const nextSegs: RecordPlanSegment[] =
                                val === "1"
                                  ? [{ start: "0000", end: "2400", mode: 1 }]
                                  : val === "2"
                                    ? [{ start: "0000", end: "2400", mode: 2 }]
                                    : [];
                              setDraft((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      recordPlan: {
                                        ...prev.recordPlan,
                                        days: { ...prev.recordPlan.days, [dayKey]: nextSegs },
                                      },
                                    }
                                  : prev,
                              );
                            }}
                            value={summary}
                          />
                        }
                        size="sm"
                      >
                        <SegmentedControlItem
                          className="grow text-[11px]"
                          render={<RadioPrimitive.Root value="off" />}
                        >
                          {t("recordModeOff")}
                        </SegmentedControlItem>
                        <SegmentedControlItem
                          className="grow text-[11px]"
                          render={<RadioPrimitive.Root value="2" />}
                        >
                          {t("recordModeEvents")}
                        </SegmentedControlItem>
                        <SegmentedControlItem
                          className="grow text-[11px]"
                          render={<RadioPrimitive.Root value="1" />}
                        >
                          {t("recordModeContinuous")}
                        </SegmentedControlItem>
                      </SegmentedControl>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Alarm Configuration */}
      {draft.alarm.supported && (
        <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <BellRingIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>{t("alarmSectionTitle")}</span>
          </div>

          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t("alarmAutoLabel")}</span>
            <Switch
              checked={draft.alarm.enabled}
              onCheckedChange={(checked) =>
                setDraft((prev) =>
                  prev ? { ...prev, alarm: { ...prev.alarm, enabled: checked } } : prev,
                )
              }
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{t("alarmVolumeLabel")}</span>
            <SegmentedControl
              className="w-full"
              render={
                <RadioGroupPrimitive
                  onValueChange={(val) =>
                    setDraft((prev) =>
                      prev
                        ? { ...prev, alarm: { ...prev.alarm, alarmVolume: val as AlarmVolume } }
                        : prev,
                    )
                  }
                  value={draft.alarm.alarmVolume}
                />
              }
              size="sm"
            >
              <SegmentedControlItem className="grow" render={<RadioPrimitive.Root value="low" />}>
                {t("alarmVolumeLow")}
              </SegmentedControlItem>
              <SegmentedControlItem className="grow" render={<RadioPrimitive.Root value="normal" />}>
                {t("alarmVolumeNormal")}
              </SegmentedControlItem>
              <SegmentedControlItem className="grow" render={<RadioPrimitive.Root value="high" />}>
                {t("alarmVolumeHigh")}
              </SegmentedControlItem>
            </SegmentedControl>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{t("alarmDurationLabel")}</span>
              <Select
                items={sirenDurationItems}
                onValueChange={(val) => {
                  if (val !== null) {
                    setDraft((prev) =>
                      prev
                        ? { ...prev, alarm: { ...prev.alarm, alarmDuration: Number(val) } }
                        : prev,
                    );
                  }
                }}
                value={String(draft.alarm.alarmDuration)}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {sirenDurationItems.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            {draft.alarm.sirenTypes.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{t("alarmTypeLabel")}</span>
                <Select
                  items={draft.alarm.sirenTypes.map((labelText, idx) => ({
                    value: String(idx),
                    label: labelText,
                  }))}
                  onValueChange={(val) => {
                    if (val !== null) {
                      setDraft((prev) =>
                        prev ? { ...prev, alarm: { ...prev.alarm, alarmType: val } } : prev,
                      );
                    }
                  }}
                  value={draft.alarm.alarmType}
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {draft.alarm.sirenTypes.map((labelText, idx) => (
                      <SelectItem key={labelText} value={String(idx)}>
                        {labelText}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tapo C200 Image & Detection Features */}
      <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium">
            <SlidersHorizontalIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>{t("c200FeaturesTitle")}</span>
          </div>
          <Button
            disabled={calibrating}
            loading={calibrating}
            onClick={() => void handleCalibrate()}
            size="xs"
            variant="outline"
          >
            <RotateCwIcon aria-hidden="true" />
            <span>{t("calibrateMotor")}</span>
          </Button>
        </div>

        {draft.autoTracking !== undefined && (
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t("autoTrackingLabel")}</span>
            <Switch
              checked={draft.autoTracking}
              onCheckedChange={(checked) =>
                setDraft((prev) => (prev ? { ...prev, autoTracking: checked } : prev))
              }
            />
          </label>
        )}

        {draft.motionDetection?.supported && (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("motionDetectionLabel")}</span>
              <Switch
                checked={draft.motionDetection.enabled}
                onCheckedChange={(checked) =>
                  setDraft((prev) =>
                    prev && prev.motionDetection
                      ? {
                          ...prev,
                          motionDetection: { ...prev.motionDetection, enabled: checked },
                        }
                      : prev,
                  )
                }
              />
            </label>
            {draft.motionDetection.enabled && (
              <SegmentedControl
                className="w-full"
                render={
                  <RadioGroupPrimitive
                    onValueChange={(val) =>
                      setDraft((prev) =>
                        prev && prev.motionDetection
                          ? {
                              ...prev,
                              motionDetection: {
                                ...prev.motionDetection,
                                sensitivity: val as DetectionSensitivity,
                              },
                            }
                          : prev,
                      )
                    }
                    value={draft.motionDetection.sensitivity}
                  />
                }
                size="sm"
              >
                {sensitivityOptions.map((opt) => (
                  <SegmentedControlItem
                    className="grow text-[11px]"
                    key={opt.value}
                    render={<RadioPrimitive.Root value={opt.value} />}
                  >
                    {opt.label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            )}
          </div>
        )}

        {draft.personDetection?.supported && (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("personDetectionLabel")}</span>
              <Switch
                checked={draft.personDetection.enabled}
                onCheckedChange={(checked) =>
                  setDraft((prev) =>
                    prev && prev.personDetection
                      ? {
                          ...prev,
                          personDetection: { ...prev.personDetection, enabled: checked },
                        }
                      : prev,
                  )
                }
              />
            </label>
            {draft.personDetection.enabled && (
              <SegmentedControl
                className="w-full"
                render={
                  <RadioGroupPrimitive
                    onValueChange={(val) =>
                      setDraft((prev) =>
                        prev && prev.personDetection
                          ? {
                              ...prev,
                              personDetection: {
                                ...prev.personDetection,
                                sensitivity: val as DetectionSensitivity,
                              },
                            }
                          : prev,
                      )
                    }
                    value={draft.personDetection.sensitivity}
                  />
                }
                size="sm"
              >
                {sensitivityOptions.map((opt) => (
                  <SegmentedControlItem
                    className="grow text-[11px]"
                    key={opt.value}
                    render={<RadioPrimitive.Root value={opt.value} />}
                  >
                    {opt.label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            )}
          </div>
        )}

        {draft.dayNightMode !== undefined && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{t("dayNightLabel")}</span>
            <SegmentedControl
              className="w-full"
              render={
                <RadioGroupPrimitive
                  onValueChange={(val) =>
                    setDraft((prev) =>
                      prev ? { ...prev, dayNightMode: val as DayNightMode } : prev,
                    )
                  }
                  value={draft.dayNightMode}
                />
              }
              size="sm"
            >
              <SegmentedControlItem className="grow text-[11px]" render={<RadioPrimitive.Root value="auto" />}>
                {t("dayNightAuto")}
              </SegmentedControlItem>
              <SegmentedControlItem className="grow text-[11px]" render={<RadioPrimitive.Root value="on" />}>
                {t("dayNightOn")}
              </SegmentedControlItem>
              <SegmentedControlItem className="grow text-[11px]" render={<RadioPrimitive.Root value="off" />}>
                {t("dayNightOff")}
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
        )}

        {draft.imageFlip !== undefined && (
          <div className="flex flex-col gap-1">
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("imageFlipLabel")}</span>
              <Switch
                checked={draft.imageFlip}
                onCheckedChange={(checked) =>
                  setDraft((prev) => (prev ? { ...prev, imageFlip: checked } : prev))
                }
              />
            </label>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("imageFlipHardwareHint")}
            </p>
          </div>
        )}

        {draft.ledEnabled !== undefined && (
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t("ledEnabledLabel")}</span>
            <Switch
              checked={draft.ledEnabled}
              onCheckedChange={(checked) =>
                setDraft((prev) => (prev ? { ...prev, ledEnabled: checked } : prev))
              }
            />
          </label>
        )}
      </div>

      <AlertDialog onOpenChange={setRebootDialogOpen} open={rebootDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rebootDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("rebootDialogDesc", { label })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button disabled={rebooting} variant="ghost" />}>
              {t("cancel")}
            </AlertDialogClose>
            <Button
              disabled={rebooting}
              loading={rebooting}
              onClick={() => void confirmReboot()}
              variant="destructive"
            >
              {t("rebootDialogConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
