import type {
  CameraMeta,
  CameraTelemetry,
  RelayStatus,
  ResolvedLanguage,
  Store,
} from "../../shared/types";
import {
  formatBytes as formatBytesI18n,
  formatDuration as formatDurationI18n,
  formatHttpRequestError,
  formatTsTime as formatTsTimeI18n,
  getStoredLanguagePref,
  relayStatusMeta as relayStatusMetaI18n,
} from "./i18n";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const pref = getStoredLanguagePref();
  const res = await fetch(path, {
    ...init,
    headers: {
      "X-Tapo-Lang": pref,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    throw new Error((json.error as string) || formatHttpRequestError(res.status, pref));
  }
  return json as T;
}

export function cameraLabel(cam: CameraMeta): string {
  return cam.customName?.trim() || cam.alias || cam.deviceName || cam.deviceModel;
}

/**
 * Legacy Tapo WAP list endpoints always return `status: 0` for modern `IOT` cameras
 * even when they are online on `iot-app-server` / CIPC relay. Only mark an `IOT` camera
 * offline when live relay telemetry or a capability check explicitly says offline.
 */
export function isCameraOnline(cam: CameraMeta, telemetry?: CameraTelemetry): boolean {
  if (
    telemetry?.status === "offline" ||
    telemetry?.status === "error" ||
    telemetry?.status === "encrypted"
  ) {
    return false;
  }
  if (
    telemetry?.status === "streaming" ||
    telemetry?.status === "connecting" ||
    telemetry?.status === "reconnecting"
  ) {
    return true;
  }
  if (cam.rawStatus === 1) return true;
  return cam.accessPlatform === "IOT";
}

export function groupHealthMeta(
  online: number,
  total: number,
): {
  state: "empty" | "all" | "partial" | "none";
  dotClass: string;
  pingClass: string | null;
  textClass: string;
  barClass: string;
} {
  if (total <= 0) {
    return {
      state: "empty",
      dotClass: "bg-neutral-500",
      pingClass: null,
      textClass: "text-muted-foreground",
      barClass: "bg-neutral-400",
    };
  }
  if (online >= total) {
    return {
      state: "all",
      dotClass: "bg-emerald-400 shadow-[0_0_8px_--theme(--color-emerald-400/75%)]",
      pingClass: "bg-emerald-400",
      textClass: "text-emerald-400",
      barClass: "bg-emerald-400",
    };
  }
  if (online > 0) {
    return {
      state: "partial",
      dotClass: "bg-amber-400 shadow-[0_0_8px_--theme(--color-amber-400/75%)]",
      pingClass: "bg-amber-400",
      textClass: "text-amber-400",
      barClass: "bg-amber-400",
    };
  }
  return {
    state: "none",
    dotClass: "bg-red-500 shadow-[0_0_8px_--theme(--color-red-500/70%)]",
    pingClass: null,
    textClass: "text-red-400",
    barClass: "bg-red-500",
  };
}

export function findCameraStore(stores: Store[], deviceId: string): Store | undefined {
  return stores.find((s) => s.cameraIds.includes(deviceId));
}

export function canUseWebCodecs(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof EncodedVideoChunk !== "undefined" &&
    typeof ReadableStream !== "undefined"
  );
}

export function relayStatusMeta(
  status: RelayStatus | undefined,
  lang: ResolvedLanguage = "ru",
): {
  label: string;
  dotClass: string;
  badgeVariant: "success" | "warning" | "error" | "secondary";
} {
  return relayStatusMetaI18n(status, lang);
}

export function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDuration(seconds: number, lang: ResolvedLanguage = "ru"): string {
  return formatDurationI18n(seconds, lang);
}

export function formatBytes(bytes: number, lang: ResolvedLanguage = "ru"): string {
  return formatBytesI18n(bytes, lang);
}

export function formatTsTime(ts: number, lang: ResolvedLanguage = "ru"): string {
  return formatTsTimeI18n(ts, lang);
}
