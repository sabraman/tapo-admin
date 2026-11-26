import {
  ActivityIcon,
  BabyIcon,
  BookmarkPlusIcon,
  CalendarIcon,
  CameraIcon,
  CarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FilmIcon,
  FolderOpenIcon,
  HardDriveIcon,
  ImagesIcon,
  PawPrintIcon,
  PlayIcon,
  RefreshCwIcon,
  ScanEyeIcon,
  ShieldAlertIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Trash2Icon,
  UserIcon,
  Volume2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { api, formatDuration, todayIsoDate } from "@/lib/api";
import { formatBytes, formatTsDate, formatTsTime, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { getClipPrimaryKind, resolveTimelineDropTarget } from "../../shared/timeline";
import type {
  CameraCapabilitySnapshot,
  CameraMeta,
  DetectionEventKind,
  MediaItem,
  RecordingClip,
  RecordingDayResponse,
} from "../../shared/types";

interface CameraArchivePanelProps {
  camera: CameraMeta;
  online: boolean;
  isSim: boolean;
  cap: CameraCapabilitySnapshot | null;
  capLoading: boolean;
  media?: MediaItem[];
  mediaDir?: string;
  onRefreshCap?: () => void;
  onMediaSaved?: (res: { item: MediaItem; media: MediaItem[]; mediaDir: string }) => void;
  onDeleteMedia?: (id: string) => Promise<void>;
  onOpenGallery?: (itemId?: string) => void;
}

type ClipFilter = "all" | "events" | "motion" | "person" | "tamper" | "segments";
type TimelineZoomHours = 24 | 6 | 2 | 1;

const primaryKind = getClipPrimaryKind;

function shiftMonth(ym: string, delta: number): string {
  const [yStr, mStr] = ym.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftIsoDate(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function parseTzOffsetSec(tz?: string): number {
  if (tz) {
    const m = tz.toUpperCase().match(/UTC\s*([+-])\s*(\d{2}):(\d{2})/);
    if (m) {
      const sign = m[1] === "-" ? -1 : 1;
      return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60);
    }
  }
  return -new Date().getTimezoneOffset() * 60;
}

function dayStartUtcSec(dateYmd: string, offsetSec: number): number {
  const [y, m, d] = dateYmd.split("-").map(Number);
  if (!y || !m || !d) {
    return Math.floor(Date.now() / 1000) - 43200;
  }
  return Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000) - offsetSec;
}

function formatClock(epochSec: number, offsetSec: number): string {
  const dt = new Date((epochSec + offsetSec) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

function formatShortHour(epochSec: number, offsetSec: number): string {
  const dt = new Date((epochSec + offsetSec) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildSimulatedClips(date: string): RecordingClip[] {
  const offsetSec = -new Date().getTimezoneOffset() * 60;
  const base = dayStartUtcSec(date, offsetSec) + 9 * 3600 + 15 * 60;
  return [
    {
      start: base + 14400,
      end: base + 14474,
      duration: 74,
      type: 6,
      startLocal: `${date} 13:15:00`,
      endLocal: `${date} 13:16:14`,
      source: "event",
      eventKinds: ["person", "motion"],
      alarmType: 6,
    },
    {
      start: base + 12600,
      end: base + 12695,
      duration: 95,
      type: 2,
      startLocal: `${date} 12:45:00`,
      endLocal: `${date} 12:46:35`,
      source: "event",
      eventKinds: ["motion"],
      alarmType: 2,
    },
    {
      start: base + 7200,
      end: base + 7320,
      duration: 120,
      type: 2,
      startLocal: `${date} 11:15:00`,
      endLocal: `${date} 11:17:00`,
      source: "event",
      eventKinds: ["motion"],
      alarmType: 2,
    },
    {
      start: base + 3600,
      end: base + 3645,
      duration: 45,
      type: 6,
      startLocal: `${date} 10:15:00`,
      endLocal: `${date} 10:15:45`,
      source: "event",
      eventKinds: ["person"],
      alarmType: 6,
    },
    {
      start: base,
      end: base + 1800,
      duration: 1800,
      type: 1,
      startLocal: `${date} 09:15:00`,
      endLocal: `${date} 09:45:00`,
      source: "segment",
      eventKinds: ["continuous"],
    },
  ];
}

function clipMatchesKind(clip: RecordingClip, kind: DetectionEventKind): boolean {
  return (clip.eventKinds ?? []).includes(kind) || primaryKind(clip) === kind;
}

function timelineColorClass(kind: DetectionEventKind): {
  bar: string;
  accent: string;
  zIndex: number;
} {
  switch (kind) {
    case "person":
      return { bar: "bg-sky-500 hover:bg-sky-400", accent: "bg-sky-500", zIndex: 30 };
    case "tamper":
    case "intrusion":
      return { bar: "bg-rose-500 hover:bg-rose-400", accent: "bg-rose-500", zIndex: 28 };
    case "motion":
    case "line_crossing":
    case "baby_cry":
      return { bar: "bg-amber-400 hover:bg-amber-300", accent: "bg-amber-400", zIndex: 20 };
    case "vehicle":
    case "pet":
      return { bar: "bg-indigo-400 hover:bg-indigo-300", accent: "bg-indigo-400", zIndex: 24 };
    case "continuous":
      return { bar: "bg-slate-500/65 hover:bg-slate-400/75", accent: "bg-slate-400", zIndex: 10 };
    default:
      return { bar: "bg-amber-400/85 hover:bg-amber-300", accent: "bg-amber-400", zIndex: 18 };
  }
}

export function CameraArchivePanel({
  camera,
  online,
  isSim,
  cap,
  capLoading,
  media = [],
  mediaDir = "",
  onRefreshCap,
  onMediaSaved,
  onDeleteMedia,
  onOpenGallery,
}: CameraArchivePanelProps): React.ReactElement {
  const { lang, t } = useI18n();
  const [subTab, setSubTab] = useState<"sd" | "downloads">("sd");
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());
  const [calendarMonth, setCalendarMonth] = useState(todayIsoDate().slice(0, 7));
  const [days, setDays] = useState<string[]>([]);
  const [daysLoading, setDaysLoading] = useState(false);

  const [recordings, setRecordings] = useState<RecordingClip[]>([]);
  const [cameraTimezone, setCameraTimezone] = useState<string | undefined>(undefined);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClipFilter>("all");

  const [playingClip, setPlayingClip] = useState<RecordingClip | null>(null);
  const [playStartSec, setPlayStartSec] = useState<number>(0);
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);
  const [autoNext, setAutoNext] = useState<boolean>(true);
  const [skipNotice, setSkipNotice] = useState<string | null>(null);

  const [savingClip, setSavingClip] = useState(false);
  const [forceLoad, setForceLoad] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [playNonce, setPlayNonce] = useState(0);

  // Timeline viewport zoom & scrubbing state
  const [zoomHours, setZoomHours] = useState<TimelineZoomHours>(24);
  const [windowStartOffsetSec, setWindowStartOffsetSec] = useState<number>(0);
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Saved downloads sub-tab state
  const cameraMedia = useMemo(
    () => media.filter((m) => m.deviceId === camera.deviceId),
    [media, camera.deviceId],
  );
  const [selectedDownloadId, setSelectedDownloadId] = useState<string | null>(null);
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);

  const selectedDownload = useMemo(
    () => cameraMedia.find((m) => m.id === selectedDownloadId) ?? cameraMedia[0] ?? null,
    [cameraMedia, selectedDownloadId],
  );

  const tzOffsetSec = useMemo(() => parseTzOffsetSec(cameraTimezone), [cameraTimezone]);
  const dayStart = useMemo(() => dayStartUtcSec(selectedDate, tzOffsetSec), [selectedDate, tzOffsetSec]);
  const dayEnd = dayStart + 86400;

  useEffect(() => {
    setPlayingClip(null);
    setPlayStartSec(0);
    setPlayheadSec(null);
    setRecordings([]);
    setRecError(null);
    setFilter("all");
    setForceLoad(false);
    setVideoLoading(false);
    setVideoError(false);
    setZoomHours(24);
    setWindowStartOffsetSec(0);
  }, [camera.deviceId]);

  useEffect(() => {
    setVideoError(false);
    setVideoLoading(Boolean(playingClip) && !isSim);
  }, [playingClip, playStartSec, isSim, playNonce]);

  useEffect(() => {
    return () => {
      if (skipTimerRef.current) clearTimeout(skipTimerRef.current);
    };
  }, []);

  const sdBlocked = cap?.sdStatus === "missing_or_unformatted" && !isSim && !forceLoad;

  useEffect(() => {
    if (!online) return;
    if (isSim) {
      const today = todayIsoDate();
      setDays(calendarMonth === today.slice(0, 7) ? [today] : []);
      return;
    }
    if (sdBlocked) {
      setDays([]);
      return;
    }
    let cancelled = false;
    setDaysLoading(true);
    void api<{ days: string[] }>(
      `/api/cameras/${encodeURIComponent(camera.deviceId)}/recordings/days?month=${encodeURIComponent(calendarMonth)}`,
    )
      .then((res) => {
        if (cancelled) return;
        const list = res.days ?? [];
        setDays(list);
        if (
          list.length > 0 &&
          (!selectedDate.startsWith(calendarMonth) ||
            (selectedDate === todayIsoDate() && !list.includes(selectedDate)))
        ) {
          setSelectedDate(list[list.length - 1]!);
        }
      })
      .catch(() => {
        if (!cancelled) setDays([]);
      })
      .finally(() => {
        if (!cancelled) setDaysLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [camera.deviceId, calendarMonth, online, isSim, sdBlocked]);

  useEffect(() => {
    if (!online) return;
    if (isSim) {
      const sim = buildSimulatedClips(selectedDate);
      setRecordings(sim);
      setCameraTimezone(undefined);
      setRecError(null);
      if (sim[0]) {
        setPlayingClip(sim[0]);
        setPlayStartSec(sim[0].start);
        setPlayheadSec(sim[0].start);
      } else {
        setPlayingClip(null);
        setPlayheadSec(null);
      }
      return;
    }
    if (sdBlocked) {
      setRecordings([]);
      setRecError(null);
      setPlayingClip(null);
      setPlayheadSec(null);
      return;
    }
    if (capLoading && !forceLoad) return;
    void loadDayRecordings(camera.deviceId, selectedDate);
  }, [camera.deviceId, selectedDate, online, isSim, sdBlocked, capLoading, forceLoad]);

  async function loadDayRecordings(deviceId: string, date: string) {
    setRecLoading(true);
    setRecError(null);
    setPlayingClip(null);
    setPlayheadSec(null);
    try {
      const res = await api<RecordingDayResponse>(
        `/api/cameras/${encodeURIComponent(deviceId)}/recordings?date=${encodeURIComponent(date)}`,
      );
      const clips = res.clips ?? [];
      setCameraTimezone(res.timezone);
      setRecordings(clips);
      if (clips.length > 0) {
        // Auto-select the latest event clip on the chosen day (matching Tapo app UX)
        const latest = clips.find((c) => c.source === "event") ?? clips[0]!;
        setPlayingClip(latest);
        setPlayStartSec(latest.start);
        setPlayheadSec(latest.start);
      }
    } catch (err) {
      setRecordings([]);
      setRecError(err instanceof Error ? err.message : t("archiveLoadError"));
    } finally {
      setRecLoading(false);
    }
  }

  function startClipPlayback(clip: RecordingClip, seekSec = clip.start, skippedGap = false) {
    const clampedStart = Math.max(clip.start, Math.min(seekSec, Math.max(clip.start, clip.end - 1)));
    setPlayingClip(clip);
    setPlayStartSec(clampedStart);
    setPlayheadSec(clampedStart);
    setVideoError(false);
    if (skippedGap) {
      const clock = formatClock(clampedStart, tzOffsetSec);
      setSkipNotice(t("playbackTimelineSkippedGap", { time: clock }));
      if (skipTimerRef.current) clearTimeout(skipTimerRef.current);
      skipTimerRef.current = setTimeout(() => setSkipNotice(null), 2600);
    } else {
      setSkipNotice(null);
    }
    centerWindowOn(clampedStart, zoomHours);
  }

  function centerWindowOn(epochSec: number, hours: TimelineZoomHours) {
    const spanSec = hours * 3600;
    if (spanSec >= 86400) {
      setWindowStartOffsetSec(0);
      return;
    }
    const rel = epochSec - dayStart;
    const clamped = Math.max(0, Math.min(86400 - spanSec, rel - spanSec / 2));
    setWindowStartOffsetSec(clamped);
  }

  function handleZoomChange(nextHours: TimelineZoomHours) {
    setZoomHours(nextHours);
    const anchor = playheadSec ?? playingClip?.start ?? (dayStart + 12 * 3600);
    centerWindowOn(anchor, nextHours);
  }

  const chronologicalClips = useMemo(
    () => [...recordings].sort((a, b) => a.start - b.start || a.end - b.end),
    [recordings],
  );

  const activeChronoIndex = useMemo(() => {
    if (!playingClip) return -1;
    return chronologicalClips.findIndex(
      (c) =>
        c.start === playingClip.start &&
        c.end === playingClip.end &&
        c.source === playingClip.source,
    );
  }, [chronologicalClips, playingClip]);

  function stepClip(delta: -1 | 1) {
    if (chronologicalClips.length === 0) return;
    const baseIdx = activeChronoIndex >= 0 ? activeChronoIndex : chronologicalClips.length - 1;
    const nextIdx = baseIdx + delta;
    if (nextIdx >= 0 && nextIdx < chronologicalClips.length) {
      startClipPlayback(chronologicalClips[nextIdx]!);
    }
  }

  async function saveClipToGallery(clip: RecordingClip) {
    if (isSim) {
      toastManager.add({
        title: t("toastSimCameraTitle"),
        description: t("toastSimClipDesc"),
        type: "info",
      });
      return;
    }
    setSavingClip(true);
    try {
      toastManager.add({ title: t("toastSdClipSaving"), type: "info" });
      const res = await api<{ item: MediaItem; media: MediaItem[]; mediaDir: string }>(
        `/api/cameras/${encodeURIComponent(camera.deviceId)}/recordings/save`,
        {
          method: "POST",
          body: JSON.stringify({ start: clip.start, end: clip.end }),
        },
      );
      onMediaSaved?.(res);
      toastManager.add({
        title: t("toastSdClipSaved"),
        description: res.item.filename,
        type: "success",
      });
    } catch (err) {
      toastManager.add({
        title: t("toastSdClipSaveError"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setSavingClip(false);
    }
  }

  async function handleDeleteDownload(id: string) {
    if (!onDeleteMedia) return;
    setDeletingMediaId(id);
    try {
      await onDeleteMedia(id);
    } finally {
      setDeletingMediaId(null);
    }
  }

  const counts = useMemo(() => {
    let events = 0;
    let motion = 0;
    let person = 0;
    let tamper = 0;
    let segments = 0;
    for (const c of recordings) {
      if (c.source === "event") events += 1;
      if (c.source === "segment" || primaryKind(c) === "continuous") segments += 1;
      if (clipMatchesKind(c, "motion")) motion += 1;
      if (clipMatchesKind(c, "person")) person += 1;
      if (clipMatchesKind(c, "tamper")) tamper += 1;
    }
    return { all: recordings.length, events, motion, person, tamper, segments };
  }, [recordings]);

  const filteredRecordings = useMemo(() => {
    switch (filter) {
      case "events":
        return recordings.filter((c) => c.source === "event");
      case "motion":
        return recordings.filter((c) => clipMatchesKind(c, "motion"));
      case "person":
        return recordings.filter((c) => clipMatchesKind(c, "person"));
      case "tamper":
        return recordings.filter((c) => clipMatchesKind(c, "tamper"));
      case "segments":
        return recordings.filter((c) => c.source === "segment" || primaryKind(c) === "continuous");
      default:
        return recordings;
    }
  }, [recordings, filter]);

  function renderEventMeta(clip: RecordingClip): {
    label: string;
    icon: React.ReactElement;
    badgeVariant: "default" | "secondary" | "warning" | "error" | "info" | "outline";
  } {
    const kind = primaryKind(clip);
    switch (kind) {
      case "person":
        return {
          label: t("eventPerson"),
          icon: <UserIcon aria-hidden="true" className="size-3.5 text-sky-400" />,
          badgeVariant: "info",
        };
      case "motion":
        return {
          label: t("eventMotion"),
          icon: <ActivityIcon aria-hidden="true" className="size-3.5 text-amber-400" />,
          badgeVariant: "warning",
        };
      case "tamper":
        return {
          label: t("eventTamper"),
          icon: <ShieldAlertIcon aria-hidden="true" className="size-3.5 text-rose-400" />,
          badgeVariant: "error",
        };
      case "line_crossing":
        return {
          label: t("eventLineCrossing"),
          icon: <ScanEyeIcon aria-hidden="true" className="size-3.5 text-amber-400" />,
          badgeVariant: "warning",
        };
      case "intrusion":
        return {
          label: t("eventIntrusion"),
          icon: <ScanEyeIcon aria-hidden="true" className="size-3.5 text-rose-400" />,
          badgeVariant: "error",
        };
      case "vehicle":
        return {
          label: t("eventVehicle"),
          icon: <CarIcon aria-hidden="true" className="size-3.5 text-indigo-400" />,
          badgeVariant: "info",
        };
      case "pet":
        return {
          label: t("eventPet"),
          icon: <PawPrintIcon aria-hidden="true" className="size-3.5 text-indigo-400" />,
          badgeVariant: "info",
        };
      case "baby_cry":
        return {
          label: t("eventBabyCry"),
          icon: <BabyIcon aria-hidden="true" className="size-3.5 text-amber-400" />,
          badgeVariant: "warning",
        };
      case "sound":
        return {
          label: t("eventSound"),
          icon: <Volume2Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />,
          badgeVariant: "secondary",
        };
      case "continuous":
        return {
          label: t("eventContinuous"),
          icon: <FilmIcon aria-hidden="true" className="size-3.5 text-slate-400" />,
          badgeVariant: "outline",
        };
      default:
        return {
          label: t("eventGeneric"),
          icon: <FilmIcon aria-hidden="true" className="size-3.5 text-amber-400" />,
          badgeVariant: "secondary",
        };
    }
  }

  const effectiveStart = playingClip ? Math.max(playingClip.start, playStartSec || playingClip.start) : 0;
  const playbackUrl =
    playingClip && !isSim
      ? `/api/cameras/${encodeURIComponent(camera.deviceId)}/recordings/play?start=${effectiveStart}&end=${playingClip.end}&v=${playNonce}`
      : "";
  const fullClipDownloadUrl =
    playingClip && !isSim
      ? `/api/cameras/${encodeURIComponent(camera.deviceId)}/recordings/play?start=${playingClip.start}&end=${playingClip.end}&download=1`
      : "";

  const sdSummary =
    cap?.sdCard?.freeSpace && cap?.sdCard?.totalSpace
      ? t("sdSpaceInfo", { free: cap.sdCard.freeSpace, total: cap.sdCard.totalSpace })
      : null;

  // Timeline coordinate math
  const windowSpanSec = zoomHours * 3600;
  const windowStartSec = dayStart + windowStartOffsetSec;
  const windowEndSec = Math.min(dayEnd, windowStartSec + windowSpanSec);

  const clientXToEpochSec = (clientX: number): number => {
    const el = timelineRef.current;
    if (!el) return windowStartSec;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(windowStartSec + ratio * windowSpanSec);
  };

  const timelineTicks = useMemo(() => {
    const stepSec =
      zoomHours === 24 ? 7200 : zoomHours === 6 ? 1800 : zoomHours === 2 ? 600 : 300;
    const firstTick = Math.ceil(windowStartSec / stepSec) * stepSec;
    const ticks: Array<{ sec: number; pct: number; label: string }> = [];
    for (let sec = firstTick; sec <= windowEndSec; sec += stepSec) {
      const pct = ((sec - windowStartSec) / windowSpanSec) * 100;
      if (pct >= 0 && pct <= 100) {
        ticks.push({ sec, pct, label: formatShortHour(sec, tzOffsetSec) });
      }
    }
    return ticks;
  }, [windowStartSec, windowEndSec, windowSpanSec, zoomHours, tzOffsetSec]);

  const activeNeedleSec = scrubSec ?? playheadSec;
  const activeNeedlePct =
    activeNeedleSec !== null && activeNeedleSec >= windowStartSec && activeNeedleSec <= windowEndSec
      ? ((activeNeedleSec - windowStartSec) / windowSpanSec) * 100
      : null;

  const hoverPct =
    hoverSec !== null && hoverSec >= windowStartSec && hoverSec <= windowEndSec
      ? ((hoverSec - windowStartSec) / windowSpanSec) * 100
      : null;

  const hoveredClip = useMemo(() => {
    if (hoverSec === null) return null;
    const matches = recordings.filter((c) => c.start <= hoverSec && hoverSec < c.end);
    if (matches.length === 0) return null;
    return (
      matches.find((c) => primaryKind(c) === "person") ??
      matches.find((c) => c.source === "event") ??
      matches[0]!
    );
  }, [recordings, hoverSec]);

  const handleTimelinePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (recordings.length === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    setScrubSec(clientXToEpochSec(e.clientX));
  };

  const handleTimelinePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const sec = clientXToEpochSec(e.clientX);
    setHoverSec(sec);
    if (isDragging) {
      setScrubSec(sec);
    }
  };

  const handleTimelinePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    const dropSec = clientXToEpochSec(e.clientX);
    setScrubSec(null);
    const resolved = resolveTimelineDropTarget(dropSec, recordings);
    if (resolved) {
      startClipPlayback(resolved.clip, resolved.seekStartSec, resolved.skippedGap);
    }
  };

  const handleTimelineWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (zoomHours >= 24) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    e.preventDefault();
    const panStep = (windowSpanSec * 0.15) * (delta > 0 ? 1 : -1);
    setWindowStartOffsetSec((prev) =>
      Math.max(0, Math.min(86400 - windowSpanSec, prev + panStep)),
    );
  };

  const selectDateAndMonth = (nextDate: string) => {
    setSelectedDate(nextDate);
    if (/^\d{4}-\d{2}/.test(nextDate)) {
      setCalendarMonth(nextDate.slice(0, 7));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Sub-navigation bar: SD Card Playback vs Local Saved Downloads */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          aria-label={t("focusModePlayback")}
          render={
            <RadioGroupPrimitive
              onValueChange={(v) => setSubTab(v as "sd" | "downloads")}
              value={subTab}
            />
          }
          size="sm"
        >
          <SegmentedControlItem render={<RadioPrimitive.Root value="sd" />}>
            <HardDriveIcon aria-hidden="true" className="size-3.5" />
            <span>{t("playbackTabSd")}</span>
          </SegmentedControlItem>
          <SegmentedControlItem render={<RadioPrimitive.Root value="downloads" />}>
            <ImagesIcon aria-hidden="true" className="size-3.5" />
            <span>{t("playbackTabDownloads")}</span>
            {cameraMedia.length > 0 && (
              <span className="rounded bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground tabular-nums">
                {cameraMedia.length}
              </span>
            )}
          </SegmentedControlItem>
        </SegmentedControl>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {subTab === "sd" && (
            <>
              <div className="flex items-center gap-1.5">
                <HardDriveIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span>
                  {cap?.sdStatus === "missing_or_unformatted" && !isSim
                    ? t("sdMissing")
                    : cap?.sdStatus === "ready" || isSim
                      ? t("sdReady")
                      : t("sdArchiveTitle")}
                </span>
              </div>
              {sdSummary && <Badge size="sm" variant="outline">{sdSummary}</Badge>}
            </>
          )}
          {subTab === "downloads" && onOpenGallery && (
            <Button onClick={() => onOpenGallery()} size="xs" variant="outline">
              <ImagesIcon aria-hidden="true" />
              <span>{t("playbackOpenFullGallery")}</span>
            </Button>
          )}
        </div>
      </div>

      {subTab === "downloads" ? (
        cameraMedia.length === 0 ? (
          <Card className="flex flex-1 items-center justify-center">
            <CardPanel className="flex max-w-md flex-col items-center gap-3 py-12 text-center">
              <div className="flex size-11 items-center justify-center rounded-full border bg-muted/40">
                <FolderOpenIcon aria-hidden="true" className="size-5 text-muted-foreground" />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{t("playbackDownloadsEmptyTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("playbackDownloadsEmptyDesc")}</p>
              </div>
              {mediaDir && (
                <code className="rounded-md border bg-muted/40 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
                  {mediaDir}
                </code>
              )}
              {onOpenGallery && media.length > 0 && (
                <Button onClick={() => onOpenGallery()} size="sm" variant="outline">
                  <ImagesIcon aria-hidden="true" />
                  <span>{t("playbackOpenFullGallery")}</span>
                </Button>
              )}
            </CardPanel>
          </Card>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
            {/* Left stage: Saved media preview */}
            <div className="flex min-h-0 flex-col gap-2.5">
              {selectedDownload && (
                <>
                  <div className="relative flex min-h-[300px] flex-1 items-center justify-center overflow-hidden rounded-2xl border bg-black shadow-lg">
                    {selectedDownload.kind === "snapshot" ? (
                      <img
                        alt={selectedDownload.cameraName}
                        className="size-full object-contain"
                        src={`/api/media/${encodeURIComponent(selectedDownload.id)}/file`}
                      />
                    ) : (
                      <video
                        autoPlay
                        className="size-full object-contain"
                        controls
                        key={selectedDownload.id}
                        playsInline
                        src={`/api/media/${encodeURIComponent(selectedDownload.id)}/file`}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/20 px-3.5 py-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {selectedDownload.kind === "snapshot" ? "JPEG" : "MP4"}
                      </Badge>
                      <span className="font-mono text-muted-foreground tabular-nums">
                        {formatTsDate(selectedDownload.createdAt, lang)}{" "}
                        {formatTsTime(selectedDownload.createdAt, lang)} ·{" "}
                        {formatBytes(selectedDownload.sizeBytes, lang)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        render={
                          <a
                            download={selectedDownload.filename}
                            href={`/api/media/${encodeURIComponent(selectedDownload.id)}/file?download=1`}
                          />
                        }
                        size="xs"
                        variant="outline"
                      >
                        <DownloadIcon aria-hidden="true" />
                        <span>{t("download")}</span>
                      </Button>
                      {onDeleteMedia && (
                        <Button
                          disabled={deletingMediaId === selectedDownload.id}
                          loading={deletingMediaId === selectedDownload.id}
                          onClick={() => void handleDeleteDownload(selectedDownload.id)}
                          size="xs"
                          variant="destructive-outline"
                        >
                          <Trash2Icon aria-hidden="true" />
                          <span>{t("delete")}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Right list: saved items for this camera */}
            <Card className="flex min-h-0 flex-col overflow-hidden">
              <CardPanel className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
                <div className="flex items-center justify-between gap-2 text-xs font-medium">
                  <span>
                    {t("playbackTabDownloads")} ({cameraMedia.length})
                  </span>
                  {mediaDir && (
                    <span className="max-w-44 truncate font-mono text-[10px] text-muted-foreground">
                      {mediaDir}
                    </span>
                  )}
                </div>
                <ScrollArea className="min-h-0 flex-1 rounded-xl border">
                  <div className="flex flex-col divide-y">
                    {cameraMedia.map((item) => {
                      const active = selectedDownload?.id === item.id;
                      return (
                        <button
                          className={cn(
                            "flex items-center justify-between gap-2 px-3 py-2.5 text-left text-xs transition-colors hover:bg-muted/50",
                            active && "bg-sky-500/12",
                          )}
                          key={item.id}
                          onClick={() => setSelectedDownloadId(item.id)}
                          type="button"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {item.kind === "snapshot" ? (
                              <CameraIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <FilmIcon aria-hidden="true" className="size-3.5 shrink-0 text-sky-400" />
                            )}
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="truncate font-medium">
                                {formatTsDate(item.createdAt, lang)} {formatTsTime(item.createdAt, lang)}
                              </span>
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                {item.kind === "snapshot" ? "JPEG" : "MP4"}
                                {item.durationSec ? ` · ${formatDuration(item.durationSec, lang)}` : ""} ·{" "}
                                {formatBytes(item.sizeBytes, lang)}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              </CardPanel>
            </Card>
          </div>
        )
      ) : sdBlocked ? (
        <Card className="flex flex-1 items-center justify-center">
          <CardPanel className="flex max-w-md flex-col items-center gap-3 py-12 text-center text-xs text-muted-foreground">
            <HardDriveIcon aria-hidden="true" className="size-8 text-muted-foreground/60" />
            <p>{t("sdMissingNote")}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {onRefreshCap && (
                <Button disabled={capLoading} onClick={onRefreshCap} size="sm" variant="outline">
                  <RefreshCwIcon aria-hidden="true" />
                  <span>{t("refreshStatusAria")}</span>
                </Button>
              )}
              <Button onClick={() => setForceLoad(true)} size="sm" variant="secondary">
                {t("archiveLoadAnyway")}
              </Button>
            </div>
          </CardPanel>
        </Card>
      ) : (
        /* Main Desktop SD Playback Layout: Wide Player + 24h Interactive Timeline on Left, Events Dock on Right */
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* Left column: Full-stage SD Player + Date & Interactive 24h Timeline */}
          <div className="flex min-h-0 flex-col gap-3">
            {/* Large 16:9 SD Video Player */}
            <div className="relative flex min-h-[260px] flex-1 items-center justify-center overflow-hidden rounded-2xl border bg-black shadow-lg">
              {!playingClip ? (
                <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-white/70">
                  {recLoading ? (
                    <>
                      <Spinner className="size-5" />
                      <span>{t("loadingRecordings")}</span>
                    </>
                  ) : recError ? (
                    <p className="max-w-sm text-rose-300">{recError}</p>
                  ) : recordings.length === 0 ? (
                    <p>{t("noRecordingsForDate")}</p>
                  ) : (
                    <p>{t("playbackSelectClipHint")}</p>
                  )}
                </div>
              ) : isSim ? (
                <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-white/75">
                  <Badge variant={renderEventMeta(playingClip).badgeVariant}>
                    {renderEventMeta(playingClip).label}
                  </Badge>
                  <span className="font-mono text-sm text-white/90 tabular-nums">
                    {playingClip.startLocal.slice(11)} — {playingClip.endLocal.slice(11)}
                  </span>
                  <p className="max-w-md text-white/65">{t("toastSimClipDesc")}</p>
                </div>
              ) : videoError ? (
                <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-white/80">
                  <p className="max-w-md">{t("archivePlaybackError")}</p>
                  <Button
                    onClick={() => setPlayNonce((n) => n + 1)}
                    size="sm"
                    variant="secondary"
                  >
                    <RefreshCwIcon aria-hidden="true" />
                    <span>{t("archiveRetryPlay")}</span>
                  </Button>
                </div>
              ) : (
                <>
                  <video
                    autoPlay
                    className="size-full object-contain"
                    controls
                    key={playbackUrl}
                    onCanPlay={() => setVideoLoading(false)}
                    onEnded={() => {
                      if (autoNext && activeChronoIndex >= 0 && activeChronoIndex + 1 < chronologicalClips.length) {
                        startClipPlayback(chronologicalClips[activeChronoIndex + 1]!);
                      }
                    }}
                    onError={() => {
                      setVideoLoading(false);
                      setVideoError(true);
                    }}
                    onLoadStart={() => setVideoLoading(true)}
                    onPlaying={() => setVideoLoading(false)}
                    onTimeUpdate={(e) => {
                      if (!isDragging && playingClip) {
                        const cur = effectiveStart + e.currentTarget.currentTime;
                        setPlayheadSec(Math.min(playingClip.end, cur));
                      }
                    }}
                    playsInline
                    ref={videoRef}
                    src={playbackUrl}
                    style={
                      camera.orientation?.rotate180
                        ? { transform: "rotate(180deg)", transformOrigin: "center" }
                        : undefined
                    }
                  />
                  {videoLoading && (
                    <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-black/75 px-3 py-1.5 text-xs text-white/90 backdrop-blur-xs">
                      <Spinner className="size-3.5" />
                      <span>{t("archivePlaybackLoading")}</span>
                    </div>
                  )}
                </>
              )}

              {skipNotice && (
                <div className="pointer-events-none absolute right-3 top-3 rounded-lg bg-black/80 px-2.5 py-1 text-[11px] font-medium text-amber-300 backdrop-blur-xs">
                  {skipNotice}
                </div>
              )}
            </div>

            {/* Active clip toolbar */}
            {playingClip && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" variant={renderEventMeta(playingClip).badgeVariant}>
                    {renderEventMeta(playingClip).icon}
                    <span>{renderEventMeta(playingClip).label}</span>
                  </Badge>
                  <span className="font-mono text-xs font-medium tabular-nums">
                    {playingClip.startLocal.slice(11)} — {playingClip.endLocal.slice(11)}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    ({formatDuration(playingClip.duration, lang)})
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    disabled={activeChronoIndex <= 0}
                    onClick={() => stepClip(-1)}
                    size="xs"
                    variant="outline"
                  >
                    <SkipBackIcon aria-hidden="true" />
                    <span className="hidden sm:inline">{t("playbackPrevClip")}</span>
                  </Button>
                  <Button
                    disabled={
                      activeChronoIndex < 0 || activeChronoIndex >= chronologicalClips.length - 1
                    }
                    onClick={() => stepClip(1)}
                    size="xs"
                    variant="outline"
                  >
                    <span className="hidden sm:inline">{t("playbackNextClip")}</span>
                    <SkipForwardIcon aria-hidden="true" />
                  </Button>

                  <label className="mx-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Switch checked={autoNext} onCheckedChange={setAutoNext} />
                    <span>{t("playbackAutoNext")}</span>
                  </label>

                  <Button
                    disabled={savingClip}
                    loading={savingClip}
                    onClick={() => void saveClipToGallery(playingClip)}
                    size="xs"
                    variant="outline"
                  >
                    <BookmarkPlusIcon aria-hidden="true" />
                    <span>{t("archiveSaveToGallery")}</span>
                  </Button>
                  {!isSim && fullClipDownloadUrl && (
                    <Button
                      aria-label={t("download")}
                      render={
                        <a
                          download={`tapo-${playingClip.start}.mp4`}
                          href={fullClipDownloadUrl}
                        />
                      }
                      size="icon-xs"
                      variant="outline"
                    >
                      <DownloadIcon aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Tapo-style Date Picker & Interactive 24h Color-Coded Timeline */}
            <Card className="shrink-0">
              <CardPanel className="flex flex-col gap-2.5 p-3">
                {/* Date navigation + Zoom controls */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      aria-label={t("playbackPrevDayAria")}
                      onClick={() => selectDateAndMonth(shiftIsoDate(selectedDate, -1))}
                      size="icon-xs"
                      variant="outline"
                    >
                      <ChevronLeftIcon aria-hidden="true" />
                    </Button>
                    <div className="relative flex items-center">
                      <CalendarIcon
                        aria-hidden="true"
                        className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
                      />
                      <Input
                        className="h-7 w-34 pl-7 text-xs font-mono tabular-nums"
                        onChange={(e) => selectDateAndMonth(e.target.value)}
                        type="date"
                        value={selectedDate}
                      />
                    </div>
                    <Button
                      aria-label={t("playbackNextDayAria")}
                      disabled={selectedDate >= todayIsoDate()}
                      onClick={() => selectDateAndMonth(shiftIsoDate(selectedDate, 1))}
                      size="icon-xs"
                      variant="outline"
                    >
                      <ChevronRightIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={t("refreshStatusAria")}
                      disabled={!online || recLoading || isSim}
                      onClick={() => void loadDayRecordings(camera.deviceId, selectedDate)}
                      size="icon-xs"
                      variant="outline"
                    >
                      <RefreshCwIcon aria-hidden="true" />
                    </Button>

                    {/* Active recording days quick-pick for selected month */}
                    <div className="hidden items-center gap-1 border-l pl-2 sm:flex">
                      <Button
                        aria-label={t("archivePrevMonthAria")}
                        disabled={daysLoading}
                        onClick={() => setCalendarMonth((m) => shiftMonth(m, -1))}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <ChevronLeftIcon aria-hidden="true" />
                      </Button>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {calendarMonth}
                      </span>
                      <Button
                        aria-label={t("archiveNextMonthAria")}
                        disabled={daysLoading}
                        onClick={() => setCalendarMonth((m) => shiftMonth(m, 1))}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <ChevronRightIcon aria-hidden="true" />
                      </Button>
                      {daysLoading ? (
                        <Spinner className="size-3" />
                      ) : (
                        days.slice(-7).map((day) => (
                          <Button
                            key={day}
                            onClick={() => setSelectedDate(day)}
                            size="xs"
                            variant={selectedDate === day ? "default" : "ghost"}
                          >
                            {day.slice(8)}
                          </Button>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Timeline zoom selector */}
                  <SegmentedControl
                    aria-label="Timeline zoom"
                    render={
                      <RadioGroupPrimitive
                        onValueChange={(v) => handleZoomChange(Number(v) as TimelineZoomHours)}
                        value={String(zoomHours)}
                      />
                    }
                    size="sm"
                  >
                    <SegmentedControlItem render={<RadioPrimitive.Root value="24" />}>
                      {t("playbackZoom24h")}
                    </SegmentedControlItem>
                    <SegmentedControlItem render={<RadioPrimitive.Root value="6" />}>
                      {t("playbackZoom6h")}
                    </SegmentedControlItem>
                    <SegmentedControlItem render={<RadioPrimitive.Root value="2" />}>
                      {t("playbackZoom2h")}
                    </SegmentedControlItem>
                    <SegmentedControlItem render={<RadioPrimitive.Root value="1" />}>
                      {t("playbackZoom1h")}
                    </SegmentedControlItem>
                  </SegmentedControl>
                </div>

                {/* Interactive Timeline Ruler + Color-Coded Track */}
                <div className="flex flex-col gap-1 select-none">
                  {/* Floating Playhead / Hover Timestamp Header */}
                  <div className="relative h-6">
                    {activeNeedlePct !== null && activeNeedleSec !== null && (
                      <div
                        className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md bg-foreground px-2 py-0.5 font-mono text-[11px] font-semibold text-background shadow-xs tabular-nums"
                        style={{ left: `${Math.max(4, Math.min(96, activeNeedlePct))}%` }}
                      >
                        {formatClock(activeNeedleSec, tzOffsetSec)}
                      </div>
                    )}
                    {hoverPct !== null && hoverSec !== null && !isDragging && (
                      <div
                        className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border bg-popover/95 px-2 py-0.5 text-[10px] text-popover-foreground shadow-sm whitespace-nowrap tabular-nums"
                        style={{ left: `${Math.max(10, Math.min(90, hoverPct))}%` }}
                      >
                        <span className="font-mono font-medium">
                          {formatClock(hoverSec, tzOffsetSec)}
                        </span>
                        <span className="ml-1.5 text-muted-foreground">
                          {hoveredClip
                            ? renderEventMeta(hoveredClip).label
                            : t("playbackTimelineNoRecording")}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Time ticks */}
                  <div className="relative h-4 text-[10px] font-mono text-muted-foreground tabular-nums">
                    {timelineTicks.map((tick) => (
                      <span
                        className="pointer-events-none absolute -translate-x-1/2"
                        key={tick.sec}
                        style={{ left: `${Math.max(2, Math.min(98, tick.pct))}%` }}
                      >
                        {tick.label}
                      </span>
                    ))}
                  </div>

                  {/* Interactive Track */}
                  <div
                    className={cn(
                      "relative h-12 w-full overflow-hidden rounded-lg border bg-zinc-900/90",
                      recordings.length > 0 ? "cursor-pointer" : "cursor-default opacity-70",
                    )}
                    onPointerCancel={() => {
                      setIsDragging(false);
                      setScrubSec(null);
                    }}
                    onPointerDown={handleTimelinePointerDown}
                    onPointerLeave={() => {
                      if (!isDragging) setHoverSec(null);
                    }}
                    onPointerMove={handleTimelinePointerMove}
                    onPointerUp={handleTimelinePointerUp}
                    onWheel={handleTimelineWheel}
                    ref={timelineRef}
                  >
                    {/* Subtle vertical grid lines for ticks */}
                    {timelineTicks.map((tick) => (
                      <div
                        className="pointer-events-none absolute inset-y-0 w-px bg-white/8"
                        key={`grid-${tick.sec}`}
                        style={{ left: `${tick.pct}%` }}
                      />
                    ))}

                    {/* Color-coded event / recording segments */}
                    {recordings.map((clip, idx) => {
                      if (clip.end < windowStartSec || clip.start > windowEndSec) return null;
                      const clampedStart = Math.max(windowStartSec, clip.start);
                      const clampedEnd = Math.min(windowEndSec, clip.end);
                      const leftPct = ((clampedStart - windowStartSec) / windowSpanSec) * 100;
                      const widthPct = ((clampedEnd - clampedStart) / windowSpanSec) * 100;
                      const kind = primaryKind(clip);
                      const style = timelineColorClass(kind);
                      const isActive =
                        playingClip?.start === clip.start &&
                        playingClip?.end === clip.end &&
                        playingClip?.source === clip.source;
                      return (
                        <div
                          className={cn(
                            "pointer-events-none absolute inset-y-0.5 rounded-[2px] transition-opacity",
                            style.bar,
                            isActive && "ring-2 ring-white ring-inset",
                          )}
                          key={`seg-${clip.source ?? "s"}-${clip.start}-${clip.end}-${idx}`}
                          style={{
                            left: `${leftPct}%`,
                            width: `max(3px, ${widthPct}%)`,
                            zIndex: isActive ? 35 : style.zIndex,
                          }}
                        />
                      );
                    })}

                    {/* Hover crosshair */}
                    {hoverPct !== null && !isDragging && (
                      <div
                        className="pointer-events-none absolute inset-y-0 z-40 w-px bg-white/50"
                        style={{ left: `${hoverPct}%` }}
                      />
                    )}

                    {/* White playhead needle */}
                    {activeNeedlePct !== null && (
                      <div
                        className="pointer-events-none absolute inset-y-0 z-50 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]"
                        style={{ left: `${activeNeedlePct}%` }}
                      />
                    )}
                  </div>

                  {/* Color Legend */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2.5 rounded-xs bg-amber-400" />
                        <span>{t("playbackLegendMotion")}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2.5 rounded-xs bg-sky-500" />
                        <span>{t("playbackLegendPerson")}</span>
                      </span>
                      {counts.tamper > 0 && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="size-2.5 rounded-xs bg-rose-500" />
                          <span>{t("playbackLegendTamper")}</span>
                        </span>
                      )}
                      {counts.segments > 0 && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="size-2.5 rounded-xs bg-slate-500/80" />
                          <span>{t("playbackLegendContinuous")}</span>
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2.5 rounded-xs border bg-zinc-900" />
                        <span>{t("playbackLegendEmpty")}</span>
                      </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground/80">
                      {t("archiveAudioNote")}
                    </span>
                  </div>
                </div>
              </CardPanel>
            </Card>
          </div>

          {/* Right column: Detected Events List Dock (matching Tapo app "Обнаруженные события (N)") */}
          <Card className="flex min-h-0 flex-col overflow-hidden">
            <CardPanel className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold">
                  {t("playbackEventsHeader", { count: filteredRecordings.length })}
                </h3>
                {recLoading && <Spinner className="size-3.5" />}
              </div>

              {/* Color-coded event filters */}
              {recordings.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  <Button
                    onClick={() => setFilter("all")}
                    size="xs"
                    variant={filter === "all" ? "default" : "outline"}
                  >
                    {t("archiveFilterAll", { count: counts.all })}
                  </Button>
                  {counts.person > 0 && (
                    <Button
                      onClick={() => setFilter("person")}
                      size="xs"
                      variant={filter === "person" ? "default" : "outline"}
                    >
                      <span className="size-2 rounded-full bg-sky-500" />
                      <span>{t("archiveFilterPerson", { count: counts.person })}</span>
                    </Button>
                  )}
                  {counts.motion > 0 && (
                    <Button
                      onClick={() => setFilter("motion")}
                      size="xs"
                      variant={filter === "motion" ? "default" : "outline"}
                    >
                      <span className="size-2 rounded-full bg-amber-400" />
                      <span>{t("archiveFilterMotion", { count: counts.motion })}</span>
                    </Button>
                  )}
                  {counts.tamper > 0 && (
                    <Button
                      onClick={() => setFilter("tamper")}
                      size="xs"
                      variant={filter === "tamper" ? "default" : "outline"}
                    >
                      <span className="size-2 rounded-full bg-rose-500" />
                      <span>{t("archiveFilterTamper", { count: counts.tamper })}</span>
                    </Button>
                  )}
                  {counts.segments > 0 && (
                    <Button
                      onClick={() => setFilter("segments")}
                      size="xs"
                      variant={filter === "segments" ? "default" : "outline"}
                    >
                      <span className="size-2 rounded-full bg-slate-400" />
                      <span>{t("archiveFilterSegments", { count: counts.segments })}</span>
                    </Button>
                  )}
                </div>
              )}

              {/* Scrollable Event Cards */}
              {recLoading ? (
                <div className="flex flex-1 items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Spinner className="size-4" />
                  <span>{t("loadingRecordings")}</span>
                </div>
              ) : recError ? (
                <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                  {recError}
                </p>
              ) : filteredRecordings.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  {t("noRecordingsForDate")}
                </p>
              ) : (
                <ScrollArea className="min-h-48 flex-1 pr-1">
                  <div className="flex flex-col gap-1.5">
                    {filteredRecordings.map((clip, idx) => {
                      const active =
                        playingClip?.start === clip.start &&
                        playingClip?.end === clip.end &&
                        playingClip?.source === clip.source;
                      const kind = primaryKind(clip);
                      const colors = timelineColorClass(kind);
                      const meta = renderEventMeta(clip);
                      return (
                        <div
                          className={cn(
                            "group relative flex cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-xl border px-3 py-2.5 text-xs transition-colors hover:bg-muted/40",
                            active && "border-sky-500/70 bg-sky-500/10",
                          )}
                          key={`${clip.source ?? "s"}-${clip.start}-${clip.end}-${idx}`}
                          onClick={() => startClipPlayback(clip)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              startClipPlayback(clip);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          {/* Left color accent strip matching timeline bar color */}
                          <span
                            aria-hidden="true"
                            className={cn("absolute inset-y-1.5 left-0 w-1 rounded-r-full", colors.accent)}
                          />

                          <div className="flex min-w-0 items-center gap-2.5 pl-1">
                            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background/80">
                              {meta.icon}
                            </div>
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-semibold tabular-nums">
                                  {clip.startLocal.slice(11)}
                                </span>
                                <span className="rounded bg-muted px-1.5 py-0.2 font-mono text-[10px] text-muted-foreground tabular-nums">
                                  {formatMmSs(clip.duration)}
                                </span>
                              </div>
                              <span className="truncate text-[11px] text-muted-foreground">
                                {meta.label}
                              </span>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              aria-label={active ? t("clipPlaying") : t("clipWatch")}
                              onClick={(e) => {
                                e.stopPropagation();
                                startClipPlayback(clip);
                              }}
                              size="icon-xs"
                              variant={active ? "default" : "ghost"}
                            >
                              <PlayIcon aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardPanel>
          </Card>
        </div>
      )}
    </div>
  );
}
