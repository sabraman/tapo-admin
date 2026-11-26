import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { DEVICE_ERROR_KEYS, type ServerMessageKey, tServer } from "../shared/i18n";
import type {
  AlarmVolume,
  CameraAlarmConfig,
  CameraCapabilitySnapshot,
  CameraMeta,
  CameraPreset,
  CameraRebootSchedule,
  CameraRecordPlan,
  CameraSettingsPatch,
  CameraSettingsSnapshot,
  DayNightMode,
  DetectionEventKind,
  DetectionSensitivity,
  RebootScheduleDay,
  RecordingClip,
  RecordingDayResponse,
  RecordPlanDayKey,
  RecordPlanSegment,
  ResolvedLanguage,
  SdCardDetails,
  StreamQuality,
} from "../shared/types";

const LOGIN_URL = "https://n-wap-gw.tplinkcloud.com";
const APP_NAME = "TP-Link_Tapo_Android";
const APP_VERSION = "3.21.114";
const ACCESS_KEY = "4d11b6b9d5ea4d19a829adbb9714b057";
const ACCESS_SECRET = "6ed7d97f3e73467f8a5bab90b577ba4c";

export interface CloudRoom {
  id: string;
  name: string;
}

export interface CloudFamily {
  id: string;
  uniqueFamilyId: string;
  name: string;
  isDefault: boolean;
  rooms: CloudRoom[];
}

function decodeBase64Utf8(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const text = Buffer.from(raw, "base64").toString("utf8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

export class TapoCloudError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly isAuthError = false,
  ) {
    super(message);
  }
}

export interface RelayTarget {
  host: string;
  port: number;
  path: string;
  relayToken: string;
  playerId: string;
  elbCookie?: string;
}

export interface LoginOutcome {
  kind: "authenticated" | "mfa_required";
  baseUrl: string;
  token?: string;
  refreshToken?: string;
  regionCode?: string;
  mfaProcessId?: string;
  supportedMFATypes?: number[];
}

function getErrorCode(obj: unknown): number {
  if (!obj || typeof obj !== "object") return 0;
  const record = obj as Record<string, unknown>;
  for (const key of ["error_code", "errorCode"]) {
    if (key in record && record[key] !== null && record[key] !== undefined) {
      const n = Number(record[key]);
      return Number.isFinite(n) ? n : 1;
    }
  }
  return 0;
}

function parseTzOffsetMs(tz: string): number {
  const match = tz.toUpperCase().match(/UTC\s*([+-])\s*(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 3600 + Number(match[3]) * 60) * 1000;
}

function formatWithOffset(epochSec: number, offsetMs: number): string {
  const d = new Date(epochSec * 1000 + offsetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export const RECORD_PLAN_DAYS: readonly RecordPlanDayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export function dayRangeUtcSec(dateYmd: string, offsetMs: number): { startSec: number; endSec: number } {
  const clean = dateYmd.replaceAll("-", "");
  const y = Number(clean.slice(0, 4));
  const m = Number(clean.slice(4, 6));
  const d = Number(clean.slice(6, 8));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || clean.length !== 8) {
    const nowSec = Math.floor(Date.now() / 1000);
    return { startSec: nowSec - 86400, endSec: nowSec };
  }
  const offsetSec = Math.trunc(offsetMs / 1000);
  const startSec = Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000) - offsetSec;
  return { startSec, endSec: startSec + 86399 };
}

function unwrapTapoListEntries(rawList: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rawList)) return [];
  const items: Array<Record<string, unknown>> = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (
      "startTime" in rec ||
      "start_time" in rec ||
      "endTime" in rec ||
      "end_time" in rec
    ) {
      items.push(rec);
      continue;
    }
    for (const val of Object.values(rec)) {
      if (val && typeof val === "object") {
        items.push(val as Record<string, unknown>);
      }
    }
  }
  return items;
}

const ALARM_TYPE_KIND_MAP: Record<number, DetectionEventKind> = {
  1: "continuous",
  2: "motion",
  3: "tamper",
  4: "line_crossing",
  5: "intrusion",
  6: "person",
  7: "baby_cry",
  8: "vehicle",
  9: "pet",
  10: "event",
  11: "sound",
  12: "sound",
};

export function decodeDetectionEventKinds(item: Record<string, unknown>): {
  kinds: DetectionEventKind[];
  alarmType?: number;
  bitmask?: number;
} {
  const kinds: DetectionEventKind[] = [];
  const addKind = (k: DetectionEventKind) => {
    if (!kinds.includes(k)) kinds.push(k);
  };

  const rawAlarmType = item.alarm_type ?? item.alarmType ?? item.type;
  const alarmType =
    rawAlarmType !== undefined && rawAlarmType !== null && Number.isFinite(Number(rawAlarmType))
      ? Number(rawAlarmType)
      : undefined;

  let bitmask: number | undefined;
  const rawEvents1 = item.events_1;
  if (typeof rawEvents1 === "number" && Number.isFinite(rawEvents1)) {
    bitmask = rawEvents1;
  } else if (typeof rawEvents1 === "string" && /^\d+$/.test(rawEvents1)) {
    bitmask = Number(rawEvents1);
  } else if (rawEvents1 && typeof rawEvents1 === "object") {
    const obj = rawEvents1 as Record<string, unknown>;
    if (obj.value !== undefined && Number.isFinite(Number(obj.value))) {
      bitmask = Number(obj.value);
    }
    if (typeof obj.type === "string") {
      const t = obj.type.toLowerCase();
      if (t.includes("person")) addKind("person");
      else if (t.includes("motion")) addKind("motion");
      else if (t.includes("tamper")) addKind("tamper");
      else if (t.includes("line")) addKind("line_crossing");
      else if (t.includes("intrusion")) addKind("intrusion");
      else if (t.includes("vehicle")) addKind("vehicle");
      else if (t.includes("pet")) addKind("pet");
      else if (t.includes("cry")) addKind("baby_cry");
    }
  }

  if (bitmask !== undefined) {
    if (bitmask & 524288) addKind("person");
    if (bitmask & 256) addKind("line_crossing");
    if (bitmask & 2) addKind("motion");
    if (bitmask & 32 && kinds.length === 0) addKind("vehicle");
  }

  if (alarmType !== undefined && alarmType in ALARM_TYPE_KIND_MAP) {
    addKind(ALARM_TYPE_KIND_MAP[alarmType]!);
  }

  if (kinds.length === 0) {
    addKind("event");
  }
  return { kinds, alarmType, bitmask };
}

export function parseDetectionListEntries(rawList: unknown, offsetMs: number): RecordingClip[] {
  const clips: RecordingClip[] = [];
  for (const item of unwrapTapoListEntries(rawList)) {
    const start = Number(item.start_time ?? item.startTime);
    const end = Number(item.end_time ?? item.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const decoded = decodeDetectionEventKinds(item);
    clips.push({
      start,
      end,
      duration: end - start,
      type: decoded.alarmType ?? 2,
      startLocal: formatWithOffset(start, offsetMs),
      endLocal: formatWithOffset(end, offsetMs),
      source: "event",
      eventKinds: decoded.kinds,
      ...(decoded.alarmType !== undefined ? { alarmType: decoded.alarmType } : {}),
      ...(decoded.bitmask !== undefined ? { eventsBitmask: decoded.bitmask } : {}),
    });
  }
  return clips;
}

export function parseVideoSegments(rawList: unknown, offsetMs: number): RecordingClip[] {
  const clips: RecordingClip[] = [];
  for (const item of unwrapTapoListEntries(rawList)) {
    const start = Number(item.startTime ?? item.start_time);
    const end = Number(item.endTime ?? item.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const type = Number(item.vedio_type ?? item.video_type ?? 0);
    const eventKinds: DetectionEventKind[] =
      type === 1 ? ["continuous"] : type === 2 ? ["event"] : ["unknown"];
    clips.push({
      start,
      end,
      duration: end - start,
      type,
      startLocal: formatWithOffset(start, offsetMs),
      endLocal: formatWithOffset(end, offsetMs),
      source: "segment",
      eventKinds,
    });
  }
  return clips;
}

export function parseRecordPlanDay(raw: unknown): RecordPlanSegment[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return [];
    }
  }
  const segments: RecordPlanSegment[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const m = entry.trim().match(/^(\d{4})-(\d{4}):([12])$/);
    if (!m) continue;
    const start = m[1]!;
    const end = m[2]!;
    const mode = Number(m[3]) === 1 ? 1 : 2;
    if (end > start) {
      segments.push({ start, end, mode });
    }
  }
  segments.sort((a, b) => a.start.localeCompare(b.start));
  return segments;
}

export function serializeRecordPlanDay(segments: RecordPlanSegment[]): string {
  const normalized = segments
    .filter(
      (s) =>
        /^\d{4}$/.test(s.start) &&
        /^\d{4}$/.test(s.end) &&
        s.end > s.start &&
        (s.mode === 1 || s.mode === 2),
    )
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((s) => `${s.start}-${s.end}:${s.mode}`);
  return JSON.stringify(normalized);
}

function emptyRecordPlanDays(): Record<RecordPlanDayKey, RecordPlanSegment[]> {
  return {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  };
}

export function extractSdCardDetails(
  sdEntry: Record<string, unknown> | undefined,
  circularEntry?: Record<string, unknown>,
): {
  sdStatus: "ready" | "missing_or_unformatted" | "unknown";
  sdErrorCode?: number;
  sdCard?: SdCardDetails;
} {
  const sdErr = sdEntry ? getErrorCode(sdEntry) : -1;
  const rawManage = (sdEntry?.result as Record<string, unknown> | undefined)?.harddisk_manage as
    | Record<string, unknown>
    | undefined;
  const hdArr = Array.isArray(rawManage?.hd_info) ? rawManage.hd_info : [];
  let infoObj: Record<string, unknown> | undefined;
  if (hdArr.length > 0 && hdArr[0] && typeof hdArr[0] === "object") {
    const first = hdArr[0] as Record<string, unknown>;
    if ("status" in first || "total_space" in first || "detect_status" in first) {
      infoObj = first;
    } else {
      const inner = Object.values(first).find((v) => v && typeof v === "object");
      if (inner) infoObj = inner as Record<string, unknown>;
    }
  }

  let sdStatus: "ready" | "missing_or_unformatted" | "unknown" =
    sdErr === 0 ? "ready" : "unknown";

  const statusText = typeof infoObj?.status === "string" ? infoObj.status : "";
  const detectStatusText =
    typeof infoObj?.detect_status === "string" ? infoObj.detect_status : "";
  const statusLower = statusText.toLowerCase();
  const detectLower = detectStatusText.toLowerCase();

  if (sdErr === 0) {
    if (hdArr.length === 0) {
      sdStatus = "missing_or_unformatted";
    } else if (
      ["unformatted", "no_disk", "not_formatted"].includes(statusLower) ||
      detectLower === "no_disk" ||
      ((statusLower === "offline" || detectLower === "offline") && !infoObj?.total_space)
    ) {
      sdStatus = "missing_or_unformatted";
    }
  }

  const circularManage = (circularEntry?.result as Record<string, unknown> | undefined)
    ?.harddisk_manage as Record<string, unknown> | undefined;
  const circularHarddisk = circularManage?.harddisk as Record<string, unknown> | undefined;
  const loopFromCircular =
    circularEntry && getErrorCode(circularEntry) === 0 && typeof circularHarddisk?.loop === "string"
      ? circularHarddisk.loop === "on"
      : undefined;
  const loopFromHd =
    infoObj?.loop_record_status !== undefined
      ? String(infoObj.loop_record_status) === "1"
      : undefined;
  const loopRecordEnabled = loopFromCircular ?? loopFromHd;

  const sdCard: SdCardDetails | undefined = infoObj
    ? {
        status: statusText || sdStatus,
        ...(typeof infoObj.total_space === "string" ? { totalSpace: infoObj.total_space } : {}),
        ...(typeof infoObj.free_space === "string" ? { freeSpace: infoObj.free_space } : {}),
        ...(infoObj.percent !== undefined && Number.isFinite(Number(infoObj.percent))
          ? { percent: Number(infoObj.percent) }
          : {}),
        ...(typeof infoObj.rw_attr === "string" ? { rwAttr: infoObj.rw_attr } : {}),
        ...(loopRecordEnabled !== undefined ? { loopRecordEnabled } : {}),
      }
    : undefined;

  return {
    sdStatus,
    ...(sdErr !== 0 ? { sdErrorCode: sdErr } : {}),
    ...(sdCard ? { sdCard } : {}),
  };
}

function normalizeSensitivityLabel(raw: unknown, numeric?: unknown): DetectionSensitivity {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "low") return "low";
  if (s === "high") return "high";
  if (s === "normal" || s === "medium") return "normal";
  const n = Number(numeric ?? raw);
  if (Number.isFinite(n)) {
    if (n <= 33) return "low";
    if (n >= 67) return "high";
  }
  return "normal";
}

function sensitivityToNumber(level: DetectionSensitivity): string {
  if (level === "low") return "20";
  if (level === "high") return "80";
  return "50";
}

function sensitivityToApiLabel(level: DetectionSensitivity): string {
  if (level === "low") return "low";
  if (level === "high") return "high";
  return "medium";
}

function parsePresetsFromResult(res: Record<string, unknown> | undefined): CameraPreset[] {
  const presetObj = ((res?.result as Record<string, unknown> | undefined)?.preset as
    | Record<string, unknown>
    | undefined)?.preset as Record<string, unknown> | undefined;
  const ids = Array.isArray(presetObj?.id) ? presetObj.id : [];
  const names = Array.isArray(presetObj?.name) ? presetObj.name : [];
  const out: CameraPreset[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] ?? "").trim();
    if (!id) continue;
    out.push({ id, name: String(names[i] ?? id) });
  }
  return out;
}

export class TapoCloudClient {
  readonly combinedCa: string[];
  private cipcUrl = "";
  private iotAppServer = "";
  private servicesSyncVersion: "v2" | "v1" = "v2";
  private playbackIndexCache = new Map<
    string,
    { clientId: number; startSec: number; endSec: number; updatedAt: number }
  >();

  constructor(
    caPemPath: string,
    private getLang: () => ResolvedLanguage = () => "en",
  ) {
    const raw = readFileSync(caPemPath, "utf8");
    const extraCerts = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    this.combinedCa = [...tls.rootCertificates, ...extraCerts];
  }

  resetServiceCache(): void {
    this.cipcUrl = "";
    this.iotAppServer = "";
    this.servicesSyncVersion = "v2";
    this.playbackIndexCache.clear();
  }

  invalidatePlaybackSession(deviceId: string): void {
    this.playbackIndexCache.delete(deviceId);
  }

  private deviceErrorMessage(code: number, fallbackKey: ServerMessageKey): string {
    const lang = this.getLang();
    const mappedKey = DEVICE_ERROR_KEYS[code];
    if (mappedKey) return tServer(lang, mappedKey);
    return tServer(lang, fallbackKey, { code });
  }

  private signHeaders(body: string, endpoint: string): Record<string, string> {
    const nonce = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const contentMd5 = createHash("md5").update(body, "utf8").digest("base64");
    const payload = `${contentMd5}\n${timestamp}\n${nonce}\n${endpoint}`;
    const signature = createHmac("sha1", ACCESS_SECRET).update(payload, "utf8").digest("hex");
    return {
      "Content-Type": "application/json; charset=UTF-8",
      "Content-MD5": contentMd5,
      "X-Authorization": `Timestamp=${timestamp}, Nonce=${nonce}, AccessKey=${ACCESS_KEY}, Signature=${signature}`,
      "User-Agent": "okhttp/3.12.13",
    };
  }

  private async postWap(
    baseUrl: string,
    endpoint: string,
    payload: Record<string, unknown>,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const cleanBase = baseUrl.replace(/\/+$/, "");
    const url = token ? `${cleanBase}${endpoint}?token=${encodeURIComponent(token)}` : `${cleanBase}${endpoint}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.signHeaders(body, endpoint),
      body,
      tls: { ca: this.combinedCa },
      signal: AbortSignal.timeout(20_000),
    });
    const decoded = (await res.json()) as Record<string, unknown>;
    const outerCode = getErrorCode(decoded);
    if (outerCode === -20651) {
      throw new TapoCloudError(tServer(this.getLang(), "session_expired_cloud"), outerCode, true);
    }
    return decoded;
  }

  async login(email: string, password: string, terminalUuid: string): Promise<LoginOutcome> {
    const payload = {
      appType: APP_NAME,
      appVersion: APP_VERSION,
      cloudPassword: password,
      cloudUserName: email,
      platform: "Android 14",
      refreshTokenNeeded: true,
      supportBindAccount: false,
      terminalMeta: "1",
      terminalName: "Tapo Admin",
      terminalUUID: terminalUuid,
    };

    let baseUrl = LOGIN_URL;
    let res = await this.postWap(baseUrl, "/api/v2/account/login", payload);
    let outerCode = getErrorCode(res);
    if (outerCode !== 0) {
      throw new TapoCloudError(
        tServer(this.getLang(), "login_failed_code", { code: outerCode }),
        outerCode,
      );
    }

    let result = (res.result ?? {}) as Record<string, unknown>;
    if (getErrorCode(result) === -20212 && typeof result.appServerUrl === "string") {
      baseUrl = result.appServerUrl;
      res = await this.postWap(baseUrl, "/api/v2/account/login", payload);
      outerCode = getErrorCode(res);
      if (outerCode !== 0) {
        throw new TapoCloudError(
          tServer(this.getLang(), "login_regional_failed_code", { code: outerCode }),
          outerCode,
        );
      }
      result = (res.result ?? {}) as Record<string, unknown>;
    }

    if (typeof result.MFAProcessId === "string" && result.MFAProcessId.length > 0) {
      const rawTypes = Array.isArray(result.supportedMFATypes) ? result.supportedMFATypes : [2];
      return {
        kind: "mfa_required",
        baseUrl,
        mfaProcessId: result.MFAProcessId,
        supportedMFATypes: rawTypes.map((n) => Number(n)).filter((n) => n === 1 || n === 2),
      };
    }

    const innerCode = getErrorCode(result);
    if (innerCode !== 0 || typeof result.token !== "string") {
      const lang = this.getLang();
      const msg =
        innerCode === -20601
          ? tServer(lang, "login_invalid_creds")
          : tServer(lang, "login_rejected_code", { code: innerCode });
      throw new TapoCloudError(msg, innerCode);
    }

    return {
      kind: "authenticated",
      baseUrl: typeof result.appServerUrl === "string" ? result.appServerUrl : baseUrl,
      token: result.token,
      refreshToken: typeof result.refreshToken === "string" ? result.refreshToken : undefined,
      regionCode: typeof result.regionCode === "string" ? result.regionCode : "EU",
    };
  }

  async requestMfa(
    baseUrl: string,
    email: string,
    password: string,
    terminalUuid: string,
    mfaType: number,
  ): Promise<void> {
    const endpoint =
      mfaType === 1 ? "/api/v2/account/getPushVC4TerminalMFA" : "/api/v2/account/getEmailVC4TerminalMFA";
    const res = await this.postWap(baseUrl, endpoint, {
      appType: APP_NAME,
      cloudPassword: password,
      cloudUserName: email,
      terminalUUID: terminalUuid,
    });
    const code = getErrorCode(res) || getErrorCode(res.result);
    if (code !== 0) {
      throw new TapoCloudError(tServer(this.getLang(), "mfa_send_failed", { code }), code);
    }
  }

  async verifyMfa(
    baseUrl: string,
    email: string,
    code: string,
    mfaProcessId: string,
    mfaType: number,
  ): Promise<{ token: string; refreshToken?: string; baseUrl: string; regionCode: string }> {
    const res = await this.postWap(baseUrl, "/api/v2/account/checkMFACodeAndLogin", {
      appType: APP_NAME,
      cloudUserName: email,
      code: code.trim(),
      MFAProcessId: mfaProcessId,
      MFAType: mfaType,
      terminalBindEnabled: true,
    });
    const err = getErrorCode(res) || getErrorCode(res.result);
    const result = (res.result ?? {}) as Record<string, unknown>;
    if (err !== 0 || typeof result.token !== "string") {
      throw new TapoCloudError(tServer(this.getLang(), "mfa_rejected", { code: err }), err);
    }
    return {
      token: result.token,
      refreshToken: typeof result.refreshToken === "string" ? result.refreshToken : undefined,
      baseUrl: typeof result.appServerUrl === "string" ? result.appServerUrl : baseUrl,
      regionCode: typeof result.regionCode === "string" ? result.regionCode : "EU",
    };
  }

  private iotHeaders(token: string, terminalUuid: string): Record<string, string> {
    return {
      Authorization: `ut|${token}`,
      "app-cid": `app:${APP_NAME}:${terminalUuid}`,
      "x-app-name": APP_NAME,
      "x-app-version": APP_VERSION,
      "x-term-id": terminalUuid,
      "x-ospf": "Android 14",
      "x-net-type": "wifi",
      "x-strict": "0",
      "x-locale": this.getLang() === "ru" ? "ru_RU" : "en_US",
      "Content-Type": "application/json; charset=UTF-8",
      "User-Agent": `${APP_NAME}/${APP_VERSION}(cloud-only;Bun)`,
    };
  }

  private async fetchIotJson(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const iotBase = await this.ensureIotServer(baseUrl, token);
    const url = `${iotBase.replace(/\/+$/, "")}${path}`;
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: this.iotHeaders(token, terminalUuid),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      tls: { ca: this.combinedCa },
      signal: AbortSignal.timeout(20_000),
    });
    const decoded = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 || getErrorCode(decoded) === -20651) {
      throw new TapoCloudError(tServer(this.getLang(), "session_expired_tapo"), -20651, true);
    }
    if (!res.ok) {
      const msg = String(decoded.message ?? decoded.msg ?? `HTTP ${res.status}`);
      throw new TapoCloudError(msg, res.status);
    }
    return decoded;
  }

  async listFamilies(baseUrl: string, token: string, terminalUuid: string): Promise<CloudFamily[]> {
    const out: CloudFamily[] = [];
    for (let page = 0; page < 10; page++) {
      const decoded = await this.fetchIotJson(
        baseUrl,
        token,
        terminalUuid,
        `/v2/families?page=${page}&pageSize=50`,
      );
      const data = Array.isArray(decoded.data) ? (decoded.data as Array<Record<string, unknown>>) : [];
      for (const f of data) {
        const rawRooms = Array.isArray(f.rooms) ? (f.rooms as Array<Record<string, unknown>>) : [];
        out.push({
          id: String(f.id ?? "default"),
          uniqueFamilyId: String(f.uniqueFamilyId ?? f.id ?? "default"),
          name: String(f.name ?? "").trim(),
          isDefault: Boolean(f.default),
          rooms: rawRooms
            .filter((r) => typeof r.id === "string" && typeof r.name === "string")
            .map((r) => ({ id: String(r.id), name: String(r.name) })),
        });
      }
      const total = Number(decoded.total ?? out.length);
      if (data.length < 50 || out.length >= total) break;
    }
    return out;
  }

  async listThings(baseUrl: string, token: string, terminalUuid: string): Promise<Map<string, Record<string, unknown>>> {
    const byId = new Map<string, Record<string, unknown>>();
    for (let page = 0; page < 10; page++) {
      const decoded = await this.fetchIotJson(
        baseUrl,
        token,
        terminalUuid,
        `/v2/things?page=${page}&pageSize=50`,
      );
      const data = Array.isArray(decoded.data) ? (decoded.data as Array<Record<string, unknown>>) : [];
      for (const t of data) {
        if (typeof t.thingName === "string") {
          byId.set(t.thingName, t);
        }
      }
      const total = Number(decoded.total ?? byId.size);
      if (data.length < 50 || byId.size >= total) break;
    }
    return byId;
  }

  async upsertCloudRoom(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    familyId: string,
    roomId: string,
    name: string,
  ): Promise<CloudRoom> {
    const res = await this.fetchIotJson(
      baseUrl,
      token,
      terminalUuid,
      `/v1/families/${encodeURIComponent(familyId)}/rooms`,
      { method: "PUT", body: { id: roomId, name } },
    );
    return {
      id: String(res.id ?? roomId),
      name: String(res.name ?? name),
    };
  }

  async deleteCloudRoom(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    familyId: string,
    roomId: string,
  ): Promise<void> {
    await this.fetchIotJson(
      baseUrl,
      token,
      terminalUuid,
      `/v1/families/${encodeURIComponent(familyId)}/rooms/${encodeURIComponent(roomId)}`,
      { method: "DELETE" },
    );
  }

  async setDeviceNickname(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    nickname: string,
  ): Promise<void> {
    const encoded = Buffer.from(nickname, "utf8").toString("base64");
    await this.fetchIotJson(
      baseUrl,
      token,
      terminalUuid,
      `/v1/things/${encodeURIComponent(deviceId)}/settings`,
      { method: "PATCH", body: { nickname: encoded } },
    );
  }

  async listCamerasAndFamilies(
    baseUrl: string,
    token: string,
    terminalUuid?: string,
  ): Promise<{ cameras: CameraMeta[]; families: CloudFamily[] }> {
    const cameras: CameraMeta[] = [];
    for (let index = 0; index < 200; index += 20) {
      const res = await this.postWap(
        baseUrl,
        "/api/v2/common/getDeviceListByPage",
        { deviceTypeList: ["SMART.IPCAMERA"], index, limit: 20 },
        token,
      );
      const err = getErrorCode(res);
      if (err !== 0) {
        throw new TapoCloudError(tServer(this.getLang(), "camera_list_failed", { code: err }), err);
      }
      const result = (res.result ?? {}) as Record<string, unknown>;
      const list = Array.isArray(result.deviceList) ? result.deviceList : [];
      for (const raw of list) {
        const d = raw as Record<string, unknown>;
        cameras.push({
          deviceId: String(d.deviceId ?? ""),
          alias: String(d.alias ?? d.deviceName ?? "Tapo Camera"),
          deviceModel: String(d.deviceModel ?? "Tapo"),
          deviceName: String(d.deviceName ?? d.deviceModel ?? ""),
          deviceHwVer: String(d.deviceHwVer ?? ""),
          fwVer: String(d.fwVer ?? ""),
          deviceRegion: String(d.deviceRegion ?? ""),
          mac: typeof d.deviceMac === "string" ? d.deviceMac : undefined,
          accessPlatform: String(d.accessPlatform ?? "IOT"),
          appServerUrl: String(d.appServerUrl ?? baseUrl),
          deviceType: String(d.deviceType ?? "SMART.IPCAMERA"),
          rawStatus: Number(d.status ?? 0),
        });
      }
      const total = Number(result.totalNum ?? cameras.length);
      if (list.length < 20 || cameras.length >= total) break;
    }

    let families: CloudFamily[] = [];
    if (terminalUuid) {
      try {
        const [fams, things] = await Promise.all([
          this.listFamilies(baseUrl, token, terminalUuid),
          this.listThings(baseUrl, token, terminalUuid),
        ]);
        families = fams;
        for (const cam of cameras) {
          const thing = things.get(cam.deviceId);
          if (!thing) continue;
          const decodedNick = decodeBase64Utf8(thing.nickname);
          if (decodedNick) {
            cam.cloudNickname = decodedNick;
            cam.alias = decodedNick;
          }
          if (typeof thing.familyId === "string") cam.familyId = thing.familyId;
          if (typeof thing.roomId === "string") cam.roomId = thing.roomId;
          if (thing.status !== undefined && thing.status !== null) {
            cam.rawStatus = Number(thing.status);
          }
        }
      } catch (err) {
        if (err instanceof TapoCloudError && err.isAuthError) throw err;
        // Fallback cleanly to WAP camera list if iot-app-server families/things is transiently unavailable.
      }
    }

    return { cameras, families };
  }

  async listCameras(baseUrl: string, token: string, terminalUuid?: string): Promise<CameraMeta[]> {
    const res = await this.listCamerasAndFamilies(baseUrl, token, terminalUuid);
    return res.cameras;
  }

  private async discoverService(baseUrl: string, token: string, serviceId: string): Promise<string> {
    const res = await this.postWap(
      baseUrl,
      "/api/v2/common/getAppServiceUrl",
      { serviceIds: [serviceId] },
      token,
    );
    const err = getErrorCode(res);
    if (err !== 0) {
      throw new TapoCloudError(
        tServer(this.getLang(), "service_discovery_failed", { serviceId, code: err }),
        err,
      );
    }
    const urls = ((res.result ?? {}) as Record<string, unknown>).serviceUrls as Record<string, string> | undefined;
    const url = urls?.[serviceId];
    if (!url) {
      throw new TapoCloudError(tServer(this.getLang(), "service_not_found", { serviceId }));
    }
    return url.replace(/^http:\/\//, "https://");
  }

  private async ensureCipc(baseUrl: string, token: string): Promise<string> {
    if (!this.cipcUrl) {
      this.cipcUrl = await this.discoverService(baseUrl, token, "cipc.api.cloud");
    }
    return this.cipcUrl;
  }

  private async ensureIotServer(baseUrl: string, token: string): Promise<string> {
    if (!this.iotAppServer) {
      this.iotAppServer = await this.discoverService(baseUrl, token, "nbu.iot-app-server.app");
    }
    return this.iotAppServer;
  }

  async servicesSyncRaw(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    requestData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const iotBase = await this.ensureIotServer(baseUrl, token);
    const body = JSON.stringify({
      inputParams: { requestData },
      serviceId: "passthrough",
    });

    const headers = this.iotHeaders(token, terminalUuid);

    const callVersion = async (ver: "v2" | "v1") => {
      const url = `${iotBase.replace(/\/+$/, "")}/${ver}/things/${encodeURIComponent(deviceId)}/services-sync`;
      return await fetch(url, {
        method: "POST",
        headers,
        body,
        tls: { ca: this.combinedCa },
        signal: AbortSignal.timeout(20_000),
      });
    };

    let res = await callVersion(this.servicesSyncVersion);
    if ([404, 405, 501].includes(res.status) && this.servicesSyncVersion === "v2") {
      this.servicesSyncVersion = "v1";
      res = await callVersion("v1");
    }

    const decoded = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 || getErrorCode(decoded) === -20651) {
      throw new TapoCloudError(tServer(this.getLang(), "session_expired_tapo"), -20651, true);
    }
    if (!res.ok) {
      const msg = String(decoded.message ?? decoded.msg ?? `HTTP ${res.status}`);
      throw new TapoCloudError(msg, res.status);
    }

    const output = (decoded.outputParams ?? {}) as Record<string, unknown>;
    const responseData = (output.responseData ?? {}) as Record<string, unknown>;
    const dataCode = getErrorCode(responseData);
    if (dataCode !== 0) {
      throw new TapoCloudError(
        this.deviceErrorMessage(dataCode, "camera_rejected_request"),
        dataCode,
      );
    }
    return responseData;
  }

  async servicesSync(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    requests: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const responseData = await this.servicesSyncRaw(baseUrl, token, terminalUuid, deviceId, {
      method: "multipleRequest",
      params: { requests },
    });
    const responses = ((responseData.result ?? {}) as Record<string, unknown>).responses;
    if (!Array.isArray(responses)) {
      throw new TapoCloudError(tServer(this.getLang(), "camera_no_response"));
    }
    return responses as Array<Record<string, unknown>>;
  }

  private isRecoverableMethodOrFormatError(err: unknown): boolean {
    if (!(err instanceof TapoCloudError) || err.isAuthError) return false;
    if (
      err.code === -40106 ||
      err.code === -40209 ||
      err.code === -40210 ||
      err.code === 400
    ) {
      return true;
    }
    return err.message.includes("PASSTHROUGH_PAYLOAD_FORMAT_CHECK_FAIL");
  }

  private async execDeviceCommand(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    method: string,
    params: Record<string, unknown>,
    fallbackKey: ServerMessageKey,
  ): Promise<Record<string, unknown>> {
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      { method, params },
    ]);
    if (res.length === 0 || !res[0]) {
      throw new TapoCloudError(tServer(this.getLang(), "camera_no_response"));
    }
    const code = getErrorCode(res[0]);
    if (code !== 0) {
      throw new TapoCloudError(this.deviceErrorMessage(code, fallbackKey), code);
    }
    return (res[0]?.result ?? {}) as Record<string, unknown>;
  }

  async getCapabilitySnapshot(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
  ): Promise<CameraCapabilitySnapshot> {
    try {
      const responses = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
        { method: "getVideoCapability", params: { video_capability: { name: ["main", "minor"] } } },
        { method: "getAppComponentList", params: { app_component: { name: ["app_component_list"] } } },
        { method: "getLensMaskConfig", params: { lens_mask: { name: ["lens_mask_info"] } } },
        { method: "getSdCardStatus", params: { harddisk_manage: { table: ["hd_info"] } } },
        { method: "getClockStatus", params: { system: { name: ["clock_status"] } } },
        { method: "getAudioConfig", params: { audio_config: { name: ["speaker", "microphone"] } } },
        { method: "getAlertConfig", params: { msg_alarm: { name: ["chn1_msg_alarm_info"] } } },
        { method: "getLastAlarmInfo", params: { msg_alarm: { name: ["chn1_msg_alarm_info"] } } },
        { method: "getPresetConfig", params: { preset: { name: ["preset"] } } },
      ]);

      const byMethod = new Map<string, Record<string, unknown>>();
      for (const r of responses) {
        if (typeof r.method === "string") byMethod.set(r.method, r);
      }

      const cap = byMethod.get("getVideoCapability")?.result as Record<string, unknown> | undefined;
      const mainCap = ((cap?.video_capability as Record<string, unknown> | undefined)?.main ?? {}) as Record<
        string,
        unknown
      >;
      const compRes = byMethod.get("getAppComponentList")?.result as Record<string, unknown> | undefined;
      const compList = ((compRes?.app_component as Record<string, unknown> | undefined)?.app_component_list ?? []) as Array<
        Record<string, unknown>
      >;
      const maskRes = byMethod.get("getLensMaskConfig")?.result as Record<string, unknown> | undefined;
      const maskEnabled = (
        (maskRes?.lens_mask as Record<string, unknown> | undefined)?.lens_mask_info as
          | Record<string, unknown>
          | undefined
      )?.enabled;
      const sdDetails = extractSdCardDetails(byMethod.get("getSdCardStatus"));
      const clockRes = byMethod.get("getClockStatus")?.result as Record<string, unknown> | undefined;
      const localTime = (
        (clockRes?.system as Record<string, unknown> | undefined)?.clock_status as Record<string, unknown> | undefined
      )?.local_time;
      const audioCfg = (byMethod.get("getAudioConfig")?.result as Record<string, unknown> | undefined)?.audio_config as
        | Record<string, unknown>
        | undefined;
      const micCfg = (audioCfg?.microphone ?? {}) as Record<string, unknown>;
      const spkCfg = (audioCfg?.speaker ?? {}) as Record<string, unknown>;
      const alertEntry = byMethod.get("getAlertConfig");
      const lastAlarmEntry = byMethod.get("getLastAlarmInfo");
      const activeAlarmEntry =
        alertEntry && getErrorCode(alertEntry) === 0
          ? alertEntry
          : lastAlarmEntry && getErrorCode(lastAlarmEntry) === 0
            ? lastAlarmEntry
            : undefined;
      const alarmInfo = (
        (activeAlarmEntry?.result as Record<string, unknown> | undefined)?.msg_alarm as
          | Record<string, unknown>
          | undefined
      )?.chn1_msg_alarm_info as Record<string, unknown> | undefined;
      const presets = parsePresetsFromResult(byMethod.get("getPresetConfig"));

      return {
        deviceId,
        online: true,
        privacyOn: maskEnabled === "on" ? true : maskEnabled === "off" ? false : null,
        ptzSupported: Array.isArray(compList) && compList.some((c) => c.name === "ptz"),
        sdStatus: sdDetails.sdStatus,
        ...(sdDetails.sdErrorCode !== undefined ? { sdErrorCode: sdDetails.sdErrorCode } : {}),
        ...(sdDetails.sdCard ? { sdCard: sdDetails.sdCard } : {}),
        cameraTime: typeof localTime === "string" ? localTime : undefined,
        resolutions: Array.isArray(mainCap.resolutions) ? mainCap.resolutions.map(String) : undefined,
        encodeTypes: Array.isArray(mainCap.encode_types) ? mainCap.encode_types.map(String) : undefined,
        micVolume: micCfg.volume !== undefined ? Number(micCfg.volume) : undefined,
        micMuted: micCfg.mute === "on",
        speakerVolume: spkCfg.volume !== undefined ? Number(spkCfg.volume) : undefined,
        ...(alarmInfo ? { alarmEnabled: alarmInfo.enabled === "on" } : {}),
        ...(presets.length > 0 ? { presets } : {}),
        lastCheckedAt: Date.now(),
      };
    } catch (err) {
      if (err instanceof TapoCloudError && err.isAuthError) throw err;
      return {
        deviceId,
        online: false,
        privacyOn: null,
        ptzSupported: false,
        sdStatus: "unknown",
        lastCheckedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async fetchRawAlarmInfo(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
  ): Promise<Record<string, unknown>> {
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      { method: "getAlertConfig", params: { msg_alarm: { name: ["chn1_msg_alarm_info"] } } },
      { method: "getLastAlarmInfo", params: { msg_alarm: { name: ["chn1_msg_alarm_info"] } } },
      { method: "getAlarmConfig", params: { msg_alarm: {} } },
    ]);
    for (const entry of res) {
      if (getErrorCode(entry) !== 0) continue;
      const msgAlarm = (entry.result as Record<string, unknown> | undefined)?.msg_alarm as
        | Record<string, unknown>
        | undefined;
      const info = (msgAlarm?.chn1_msg_alarm_info ?? msgAlarm) as Record<string, unknown> | undefined;
      if (info && typeof info === "object") {
        return { ...info };
      }
    }
    return {};
  }

  async getCameraSettings(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
  ): Promise<CameraSettingsSnapshot> {
    const [batchA, batchB] = await Promise.all([
      this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
        { method: "getAudioConfig", params: { audio_config: { name: ["speaker", "microphone"] } } },
        { method: "getSdCardStatus", params: { harddisk_manage: { table: ["hd_info"] } } },
        { method: "getCircularRecordingConfig", params: { harddisk_manage: { name: "harddisk" } } },
        { method: "getAlertConfig", params: { msg_alarm: { name: ["chn1_msg_alarm_info"] } } },
        { method: "getLastAlarmInfo", params: { msg_alarm: { name: ["chn1_msg_alarm_info"] } } },
        { method: "getAlarmConfig", params: { msg_alarm: {} } },
        { method: "getSirenTypeList", params: { msg_alarm: {} } },
        { method: "getSirenStatus", params: { msg_alarm: {} } },
        { method: "getReboot", params: { timing_reboot: { name: ["reboot"] } } },
        { method: "getRecordPlan", params: { record_plan: { name: ["chn1_channel"] } } },
      ]),
      this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
        { method: "getLightFrequencyInfo", params: { image: { name: "common" } } },
        { method: "getRotationStatus", params: { image: { name: ["switch"] } } },
        { method: "getLedStatus", params: { led: { name: ["config"] } } },
        { method: "getTargetTrackConfig", params: { target_track: { name: ["target_track_info"] } } },
        { method: "getDetectionConfig", params: { motion_detection: { name: ["motion_det"] } } },
        { method: "getPersonDetectionConfig", params: { people_detection: { name: ["detection"] } } },
        { method: "getPresetConfig", params: { preset: { name: ["preset"] } } },
      ]),
    ]);

    const byMethod = new Map<string, Record<string, unknown>>();
    for (const r of [...batchA, ...batchB]) {
      if (typeof r.method === "string") byMethod.set(r.method, r);
    }

    const audioCfg = (byMethod.get("getAudioConfig")?.result as Record<string, unknown> | undefined)?.audio_config as
      | Record<string, unknown>
      | undefined;
    const micCfg = (audioCfg?.microphone ?? {}) as Record<string, unknown>;
    const spkCfg = (audioCfg?.speaker ?? {}) as Record<string, unknown>;

    const sdDetails = extractSdCardDetails(
      byMethod.get("getSdCardStatus"),
      byMethod.get("getCircularRecordingConfig"),
    );

    const alertEntry = byMethod.get("getAlertConfig");
    const lastAlarmEntry = byMethod.get("getLastAlarmInfo");
    const alarmEntry = byMethod.get("getAlarmConfig");
    const activeAlarmEntry =
      alertEntry && getErrorCode(alertEntry) === 0
        ? alertEntry
        : lastAlarmEntry && getErrorCode(lastAlarmEntry) === 0
          ? lastAlarmEntry
          : alarmEntry && getErrorCode(alarmEntry) === 0
            ? alarmEntry
            : undefined;
    const alarmMsgObj = (activeAlarmEntry?.result as Record<string, unknown> | undefined)?.msg_alarm as
      | Record<string, unknown>
      | undefined;
    const alarmInfo = (alarmMsgObj?.chn1_msg_alarm_info ?? alarmMsgObj) as
      | Record<string, unknown>
      | undefined;
    const sirenListEntry = byMethod.get("getSirenTypeList");
    const rawSirenList =
      sirenListEntry && getErrorCode(sirenListEntry) === 0
        ? (sirenListEntry.result as Record<string, unknown> | undefined)?.siren_type_list
        : undefined;
    const sirenStatusEntry = byMethod.get("getSirenStatus");
    const rawSirenStatus =
      sirenStatusEntry && getErrorCode(sirenStatusEntry) === 0
        ? (sirenStatusEntry.result as Record<string, unknown> | undefined)?.status
        : undefined;

    const alarmVolRaw = String(alarmInfo?.alarm_volume ?? "normal").toLowerCase();
    const alarmVolume: AlarmVolume =
      alarmVolRaw === "low" || alarmVolRaw === "high" ? alarmVolRaw : "normal";
    const alarm: CameraAlarmConfig = {
      supported: Boolean(activeAlarmEntry),
      enabled: alarmInfo?.enabled === "on",
      alarmMode: Array.isArray(alarmInfo?.alarm_mode)
        ? alarmInfo.alarm_mode.map(String)
        : ["sound"],
      alarmType: String(alarmInfo?.alarm_type ?? "0"),
      alarmVolume,
      alarmDuration: Number.isFinite(Number(alarmInfo?.alarm_duration))
        ? Number(alarmInfo?.alarm_duration)
        : 0,
      sirenTypes: Array.isArray(rawSirenList) ? rawSirenList.map(String) : [],
      ...(rawSirenStatus === "on" || rawSirenStatus === "off"
        ? { sirenStatus: rawSirenStatus }
        : {}),
    };

    const rebootEntry = byMethod.get("getReboot");
    const rebootRaw = (
      (rebootEntry?.result as Record<string, unknown> | undefined)?.timing_reboot as
        | Record<string, unknown>
        | undefined
    )?.reboot as Record<string, unknown> | undefined;
    const validDays = new Set<RebootScheduleDay>([
      "everyday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    const rawDay = String(rebootRaw?.day ?? "everyday").toLowerCase() as RebootScheduleDay;
    const rebootSchedule: CameraRebootSchedule = {
      supported: Boolean(rebootEntry && getErrorCode(rebootEntry) === 0 && rebootRaw),
      enabled: rebootRaw?.enabled === "on",
      time: typeof rebootRaw?.time === "string" && /^\d{2}:\d{2}$/.test(rebootRaw.time)
        ? rebootRaw.time
        : "03:00",
      day: validDays.has(rawDay) ? rawDay : "everyday",
      ...(rebootRaw?.random_range !== undefined && Number.isFinite(Number(rebootRaw.random_range))
        ? { randomRange: Number(rebootRaw.random_range) }
        : {}),
    };

    const planEntry = byMethod.get("getRecordPlan");
    const planRaw = (
      (planEntry?.result as Record<string, unknown> | undefined)?.record_plan as
        | Record<string, unknown>
        | undefined
    )?.chn1_channel as Record<string, unknown> | undefined;
    const planDays = emptyRecordPlanDays();
    if (planRaw) {
      for (const dayKey of RECORD_PLAN_DAYS) {
        planDays[dayKey] = parseRecordPlanDay(planRaw[dayKey]);
      }
    }
    const recordPlan: CameraRecordPlan = {
      supported: Boolean(planEntry && getErrorCode(planEntry) === 0 && planRaw),
      enabled: planRaw?.enabled === "on",
      days: planDays,
    };

    const lightEntry = byMethod.get("getLightFrequencyInfo");
    const infType = (
      (lightEntry?.result as Record<string, unknown> | undefined)?.image as
        | Record<string, unknown>
        | undefined
    )?.common as Record<string, unknown> | undefined;
    const rawInf = typeof infType?.inf_type === "string" ? infType.inf_type : undefined;
    const dayNightMode: DayNightMode | undefined =
      rawInf === "auto" || rawInf === "on" || rawInf === "off" ? rawInf : undefined;

    const rotEntry = byMethod.get("getRotationStatus");
    const rotSwitch = (
      (rotEntry?.result as Record<string, unknown> | undefined)?.image as
        | Record<string, unknown>
        | undefined
    )?.switch as Record<string, unknown> | undefined;
    const imageFlip =
      rotEntry && getErrorCode(rotEntry) === 0 && rotSwitch
        ? rotSwitch.flip_type === "center"
        : undefined;

    const ledEntry = byMethod.get("getLedStatus");
    const ledCfg = (
      (ledEntry?.result as Record<string, unknown> | undefined)?.led as
        | Record<string, unknown>
        | undefined
    )?.config as Record<string, unknown> | undefined;
    const ledEnabled =
      ledEntry && getErrorCode(ledEntry) === 0 && ledCfg ? ledCfg.enabled === "on" : undefined;

    const trackEntry = byMethod.get("getTargetTrackConfig");
    const trackInfo = (
      (trackEntry?.result as Record<string, unknown> | undefined)?.target_track as
        | Record<string, unknown>
        | undefined
    )?.target_track_info as Record<string, unknown> | undefined;
    const autoTracking =
      trackEntry && getErrorCode(trackEntry) === 0 && trackInfo
        ? trackInfo.enabled === "on"
        : undefined;

    const motionEntry = byMethod.get("getDetectionConfig");
    const motionDet = (
      (motionEntry?.result as Record<string, unknown> | undefined)?.motion_detection as
        | Record<string, unknown>
        | undefined
    )?.motion_det as Record<string, unknown> | undefined;
    const motionDetection =
      motionEntry && getErrorCode(motionEntry) === 0 && motionDet
        ? {
            supported: true,
            enabled: motionDet.enabled === "on",
            sensitivity: normalizeSensitivityLabel(
              motionDet.sensitivity,
              motionDet.digital_sensitivity,
            ),
          }
        : { supported: false, enabled: false, sensitivity: "normal" as DetectionSensitivity };

    const personEntry = byMethod.get("getPersonDetectionConfig");
    const personDet = (
      (personEntry?.result as Record<string, unknown> | undefined)?.people_detection as
        | Record<string, unknown>
        | undefined
    )?.detection as Record<string, unknown> | undefined;
    const personDetection =
      personEntry && getErrorCode(personEntry) === 0 && personDet
        ? {
            supported: true,
            enabled: personDet.enabled === "on",
            sensitivity: normalizeSensitivityLabel(personDet.sensitivity),
          }
        : { supported: false, enabled: false, sensitivity: "normal" as DetectionSensitivity };

    const presets = parsePresetsFromResult(byMethod.get("getPresetConfig"));

    return {
      deviceId,
      online: true,
      speakerVolume: spkCfg.volume !== undefined ? Number(spkCfg.volume) : undefined,
      micVolume: micCfg.volume !== undefined ? Number(micCfg.volume) : undefined,
      micMuted: micCfg.mute === "on",
      ...(sdDetails.sdCard ? { sdCard: sdDetails.sdCard } : {}),
      alarm,
      rebootSchedule,
      recordPlan,
      ...(dayNightMode ? { dayNightMode } : {}),
      ...(imageFlip !== undefined ? { imageFlip } : {}),
      ...(ledEnabled !== undefined ? { ledEnabled } : {}),
      ...(autoTracking !== undefined ? { autoTracking } : {}),
      motionDetection,
      personDetection,
      presets,
      lastCheckedAt: Date.now(),
    };
  }

  async updateCameraSettings(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    patch: CameraSettingsPatch,
  ): Promise<CameraSettingsSnapshot> {
    if (patch.speakerVolume !== undefined && Number.isFinite(patch.speakerVolume)) {
      await this.setSpeakerVolume(baseUrl, token, terminalUuid, deviceId, patch.speakerVolume);
    }
    if (patch.micVolume !== undefined || patch.micMuted !== undefined) {
      await this.setMicrophoneConfig(baseUrl, token, terminalUuid, deviceId, {
        volume: patch.micVolume,
        mute: patch.micMuted,
      });
    }
    if (patch.alarm) {
      await this.setAlarmConfig(baseUrl, token, terminalUuid, deviceId, patch.alarm);
    }
    if (patch.rebootSchedule) {
      await this.setRebootSchedule(baseUrl, token, terminalUuid, deviceId, patch.rebootSchedule);
    }
    if (patch.recordPlan) {
      await this.setRecordPlan(baseUrl, token, terminalUuid, deviceId, patch.recordPlan);
    }
    if (patch.dayNightMode !== undefined) {
      await this.execDeviceCommand(
        baseUrl,
        token,
        terminalUuid,
        deviceId,
        "setDayNightModeConfig",
        { image: { common: { inf_type: patch.dayNightMode } } },
        "settings_error_code",
      );
    }
    if (patch.imageFlip !== undefined) {
      await this.execDeviceCommand(
        baseUrl,
        token,
        terminalUuid,
        deviceId,
        "setRotationStatus",
        { image: { switch: { flip_type: patch.imageFlip ? "center" : "off" } } },
        "settings_error_code",
      );
    }
    if (patch.ledEnabled !== undefined) {
      await this.execDeviceCommand(
        baseUrl,
        token,
        terminalUuid,
        deviceId,
        "setLedStatus",
        { led: { config: { enabled: patch.ledEnabled ? "on" : "off" } } },
        "settings_error_code",
      );
    }
    if (patch.autoTracking !== undefined) {
      await this.execDeviceCommand(
        baseUrl,
        token,
        terminalUuid,
        deviceId,
        "setTargetTrackConfig",
        { target_track: { target_track_info: { enabled: patch.autoTracking ? "on" : "off" } } },
        "settings_error_code",
      );
    }
    if (patch.motionDetection) {
      const motionDet: Record<string, string> = {};
      if (patch.motionDetection.enabled !== undefined) {
        motionDet.enabled = patch.motionDetection.enabled ? "on" : "off";
      }
      if (patch.motionDetection.sensitivity !== undefined) {
        motionDet.digital_sensitivity = sensitivityToNumber(patch.motionDetection.sensitivity);
        motionDet.sensitivity = sensitivityToApiLabel(patch.motionDetection.sensitivity);
      }
      await this.execDeviceCommand(
        baseUrl,
        token,
        terminalUuid,
        deviceId,
        "setDetectionConfig",
        { motion_detection: { motion_det: motionDet } },
        "settings_error_code",
      );
    }
    if (patch.personDetection) {
      const personDet: Record<string, string> = {};
      if (patch.personDetection.enabled !== undefined) {
        personDet.enabled = patch.personDetection.enabled ? "on" : "off";
      }
      if (patch.personDetection.sensitivity !== undefined) {
        personDet.sensitivity = sensitivityToNumber(patch.personDetection.sensitivity);
      }
      await this.execDeviceCommand(
        baseUrl,
        token,
        terminalUuid,
        deviceId,
        "setPersonDetectionConfig",
        { people_detection: { detection: personDet } },
        "settings_error_code",
      );
    }

    return await this.getCameraSettings(baseUrl, token, terminalUuid, deviceId);
  }

  async setSpeakerVolume(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    volume: number,
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "setSpeakerVolume",
      { method: "set", audio_config: { speaker: { volume: String(clamped) } } },
      "speaker_error_code",
    );
  }

  async setAlarmConfig(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    opts: {
      enabled?: boolean;
      alarmMode?: string[];
      alarmType?: string;
      alarmVolume?: AlarmVolume;
      alarmDuration?: number;
    },
  ): Promise<void> {
    const current = await this.fetchRawAlarmInfo(baseUrl, token, terminalUuid, deviceId);
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current)) {
      if (!k.startsWith(".")) cleaned[k] = v;
    }

    const merged: Record<string, unknown> = {
      alarm_type: "0",
      light_type: "0",
      alarm_mode: ["sound"],
      ...cleaned,
    };
    if (opts.enabled !== undefined) merged.enabled = opts.enabled ? "on" : "off";
    if (opts.alarmMode && opts.alarmMode.length > 0) merged.alarm_mode = opts.alarmMode;
    if (opts.alarmType !== undefined) merged.alarm_type = String(opts.alarmType);
    if (opts.alarmVolume !== undefined) merged.alarm_volume = opts.alarmVolume;
    if (opts.alarmDuration !== undefined && Number.isFinite(opts.alarmDuration)) {
      merged.alarm_duration = String(Math.max(0, Math.min(300, Math.round(opts.alarmDuration))));
    }

    if ("sound_alarm_enabled" in cleaned) {
      merged.sound_alarm_enabled =
        merged.enabled === "on" &&
        Array.isArray(merged.alarm_mode) &&
        merged.alarm_mode.includes("sound")
          ? "on"
          : "off";
    }
    if ("light_alarm_enabled" in cleaned) {
      merged.light_alarm_enabled =
        merged.enabled === "on" &&
        Array.isArray(merged.alarm_mode) &&
        merged.alarm_mode.includes("light")
          ? "on"
          : "off";
    }

    const attempts: Array<() => Promise<unknown>> = [
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "setAlertConfig",
          { msg_alarm: { chn1_msg_alarm_info: merged } },
          "alarm_error_code",
        ),
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "setAlarmConfig",
          { method: "set", msg_alarm: { chn1_msg_alarm_info: merged } },
          "alarm_error_code",
        ),
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "setAlarmConfig",
          { msg_alarm: merged },
          "alarm_error_code",
        ),
    ];

    let lastErr: unknown;
    for (const run of attempts) {
      try {
        await run();
        return;
      } catch (err) {
        lastErr = err;
        if (!this.isRecoverableMethodOrFormatError(err)) throw err;
      }
    }
    throw lastErr;
  }

  async triggerManualAlarm(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    action: "start" | "stop",
  ): Promise<void> {
    const startFlag = action === "start";
    const candidates: Array<() => Promise<unknown>> = [
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "do",
          { msg_alarm: { manual_msg_alarm: { action } } },
          "alarm_error_code",
        ),
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "do",
          { msg_alarm: { manual_alarm: { action } } },
          "alarm_error_code",
        ),
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          startFlag ? "startManualAlarm" : "stopManualAlarm",
          { msg_alarm: { manual_msg_alarm: { action } } },
          "alarm_error_code",
        ),
      async () => {
        if (startFlag) {
          const info = await this.fetchRawAlarmInfo(baseUrl, token, terminalUuid, deviceId).catch(
            () => ({} as Record<string, unknown>),
          );
          const alarmType = String(info.alarm_type ?? "0");
          return this.execDeviceCommand(
            baseUrl,
            token,
            terminalUuid,
            deviceId,
            "testUsrDefAudio",
            { msg_alarm: { test_usr_def_audio: { force: "1", id: alarmType } } },
            "alarm_error_code",
          );
        }
        return this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "testUsrDefAudio",
          { msg_alarm: { test_usr_def_audio: { action: "stop" } } },
          "alarm_error_code",
        );
      },
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "setSirenStatus",
          { msg_alarm: { status: startFlag ? "on" : "off" } },
          "alarm_error_code",
        ),
      () =>
        this.execDeviceCommand(
          baseUrl,
          token,
          terminalUuid,
          deviceId,
          "setSirenStatus",
          { siren: { status: startFlag ? "on" : "off" } },
          "alarm_error_code",
        ),
      () =>
        this.servicesSyncRaw(baseUrl, token, terminalUuid, deviceId, {
          method: "do",
          params: { msg_alarm: { manual_msg_alarm: { action } } },
        }),
    ];

    let lastErr: unknown;
    for (const run of candidates) {
      try {
        await run();
        return;
      } catch (err) {
        lastErr = err;
        if (!this.isRecoverableMethodOrFormatError(err)) throw err;
      }
    }
    throw lastErr;
  }

  async rebootCamera(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
  ): Promise<void> {
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "rebootDevice",
      { system: { reboot: "null" } },
      "reboot_error_code",
    );
  }

  async setRebootSchedule(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    opts: { enabled: boolean; time: string; day: RebootScheduleDay },
  ): Promise<void> {
    const time = /^\d{2}:\d{2}$/.test(opts.time) ? opts.time : "03:00";
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "setReboot",
      {
        timing_reboot: {
          reboot: {
            enabled: opts.enabled ? "on" : "off",
            time,
            day: opts.day || "everyday",
            random_range: 30,
          },
        },
      },
      "reboot_error_code",
    );
  }

  async setRecordPlan(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    plan: { enabled: boolean; days: Record<RecordPlanDayKey, RecordPlanSegment[]> },
  ): Promise<void> {
    const channelPayload: Record<string, string> = {
      enabled: plan.enabled ? "on" : "off",
    };
    for (const day of RECORD_PLAN_DAYS) {
      channelPayload[day] = serializeRecordPlanDay(plan.days[day] ?? []);
    }
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "setRecordPlan",
      { record_plan: { chn1_channel: channelPayload } },
      "record_plan_error_code",
    );
  }

  async goToPreset(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    presetId: string,
  ): Promise<void> {
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "motorMoveToPreset",
      { preset: { goto_preset: { id: String(presetId) } } },
      "preset_error_code",
    );
  }

  async savePreset(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    name: string,
  ): Promise<CameraPreset[]> {
    const clean = name.trim().slice(0, 32);
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "addMotorPostion",
      { preset: { set_preset: { name: clean, save_ptz: "1" } } },
      "preset_error_code",
    );
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      { method: "getPresetConfig", params: { preset: { name: ["preset"] } } },
    ]);
    return parsePresetsFromResult(res[0]);
  }

  async deletePreset(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    presetId: string,
  ): Promise<CameraPreset[]> {
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "deletePreset",
      { preset: { remove_preset: { id: [String(presetId)] } } },
      "preset_error_code",
    );
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      { method: "getPresetConfig", params: { preset: { name: ["preset"] } } },
    ]);
    return parsePresetsFromResult(res[0]);
  }

  async calibrateMotor(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
  ): Promise<void> {
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "manualCalibrate",
      { motor: { manual_cali: "" } },
      "ptz_rejected_code",
    );
  }

  async setMicrophoneConfig(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    opts: { volume?: number; mute?: boolean },
  ): Promise<void> {
    const mic: Record<string, string> = {};
    if (opts.volume !== undefined && Number.isFinite(opts.volume)) {
      mic.volume = String(Math.max(0, Math.min(100, Math.round(opts.volume))));
    }
    if (opts.mute !== undefined) {
      mic.mute = opts.mute ? "on" : "off";
    }
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "setMicrophoneVolume",
      { method: "set", audio_config: { microphone: mic } },
      "mic_error_code",
    );
  }

  async setPrivacyMode(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    enabled: boolean,
  ): Promise<boolean> {
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "setLensMaskConfig",
      { lens_mask: { lens_mask_info: { enabled: enabled ? "on" : "off" } } },
      "privacy_error_code",
    );
    return enabled;
  }

  async moveMotor(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    x: number,
    y: number,
  ): Promise<void> {
    const clampedX = Math.max(-200, Math.min(200, Math.round(x)));
    const clampedY = Math.max(-200, Math.min(200, Math.round(y)));
    await this.execDeviceCommand(
      baseUrl,
      token,
      terminalUuid,
      deviceId,
      "motorMove",
      { motor: { move: { x_coord: String(clampedX), y_coord: String(clampedY) } } },
      "ptz_rejected_code",
    );
  }

  async searchRecordingDays(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    yearMonth: string,
  ): Promise<string[]> {
    const cleanYm = yearMonth.replaceAll("-", "");
    const startDate = `${cleanYm}01`;
    const endDate = `${cleanYm}31`;
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      {
        method: "searchDateWithVideo",
        params: {
          playback: { search_year_utility: { channel: [0], start_date: startDate, end_date: endDate } },
        },
      },
    ]);
    const code = getErrorCode(res[0]);
    if (code === -71112) return [];
    if (code !== 0) {
      throw new TapoCloudError(this.deviceErrorMessage(code, "sd_error_code"), code);
    }
    const playback = ((res[0]?.result ?? {}) as Record<string, unknown>).playback as Record<string, unknown> | undefined;
    const rawDates = Array.isArray(playback?.search_results) ? playback.search_results : [];
    const dates: string[] = [];
    for (const item of rawDates) {
      if (item && typeof item === "object") {
        const val = (item as Record<string, unknown>).date;
        if (typeof val === "string") {
          const digits = val.replaceAll("-", "");
          dates.push(
            digits.length === 8
              ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
              : val,
          );
        }
      }
    }
    return dates.sort();
  }

  async searchRecordingsOfDay(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    dateYmd: string,
  ): Promise<RecordingDayResponse> {
    const cleanDate = dateYmd.replaceAll("-", "");
    const tzRes = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      {
        method: "getTimezone",
        params: { system: { name: ["basic"] } },
      },
    ]);
    const basic = (((tzRes[0]?.result as Record<string, unknown>)?.system as Record<string, unknown>)?.basic ??
      {}) as Record<string, unknown>;
    const timezone = String(basic.timezone ?? "UTC+00:00");
    const offsetMs = parseTzOffsetMs(timezone);
    const { startSec, endSec } = dayRangeUtcSec(dateYmd, offsetMs);

    const PAGE_SIZE = 200;
    const events: RecordingClip[] = [];
    const segments: RecordingClip[] = [];
    let hardErrorCode: number | null = null;
    let useUtcFallback = false;
    let detDone = false;
    let segDone = false;
    let detOffset = 0;
    let segOffset = 0;

    for (let page = 0; page < 15; page++) {
      const batchRequests: Array<Record<string, unknown>> = [];
      let detReqIdx = -1;
      let segReqIdx = -1;

      if (!detDone) {
        detReqIdx = batchRequests.length;
        batchRequests.push({
          method: "searchDetectionList",
          params: {
            playback: {
              search_detection_list: {
                channel: 0,
                start_index: detOffset,
                end_index: detOffset + PAGE_SIZE - 1,
                start_time: startSec,
                end_time: endSec,
              },
            },
          },
        });
      }
      if (!segDone && !useUtcFallback && page < 5) {
        segReqIdx = batchRequests.length;
        batchRequests.push({
          method: "searchVideoOfDay",
          params: {
            playback: {
              search_video_utility: {
                channel: [0],
                date: cleanDate,
                start_index: segOffset,
                end_index: segOffset + PAGE_SIZE - 1,
              },
            },
          },
        });
      }
      if (batchRequests.length === 0) break;

      const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, batchRequests);
      const detRes = detReqIdx >= 0 ? res[detReqIdx] : undefined;
      const segRes = segReqIdx >= 0 ? res[segReqIdx] : undefined;

      if (detRes) {
        const detCode = getErrorCode(detRes);
        if (detCode === 0) {
          const detPlayback = ((detRes.result ?? {}) as Record<string, unknown>).playback as
            | Record<string, unknown>
            | undefined;
          const parsedEvents = parseDetectionListEntries(detPlayback?.search_detection_list, offsetMs);
          events.push(...parsedEvents);
          detOffset += parsedEvents.length;
          const hasMore = Number(detPlayback?.to_be_continued ?? 0) === 1;
          if (parsedEvents.length === 0 || (!hasMore && parsedEvents.length < PAGE_SIZE)) {
            detDone = true;
          }
        } else {
          if (detCode !== -71112 && detCode !== -40210 && detCode !== -40106) {
            hardErrorCode = hardErrorCode ?? detCode;
          }
          detDone = true;
        }
      }

      if (segRes) {
        const segCode = getErrorCode(segRes);
        if (segCode === 0) {
          const segPlayback = ((segRes.result ?? {}) as Record<string, unknown>).playback as
            | Record<string, unknown>
            | undefined;
          const parsedSegs = parseVideoSegments(segPlayback?.search_video_results, offsetMs);
          segments.push(...parsedSegs);
          segOffset += parsedSegs.length;
          const hasMore = Number(segPlayback?.to_be_continued ?? 0) === 1;
          if (parsedSegs.length === 0 || (!hasMore && parsedSegs.length < PAGE_SIZE)) {
            segDone = true;
          }
        } else if (segCode === -40210 || segCode === -71103 || segCode === -71112) {
          useUtcFallback = true;
          segDone = true;
        } else {
          hardErrorCode = hardErrorCode ?? segCode;
          segDone = true;
        }
      } else if (page >= 5 || useUtcFallback) {
        segDone = true;
      }

      if (detDone && segDone) {
        break;
      }
    }

    if (useUtcFallback) {
      const cached = this.playbackIndexCache.get(deviceId);
      const uid =
        cached && Date.now() - cached.updatedAt < 10 * 60_000
          ? cached.clientId
          : await this.getPlaybackUserId(baseUrl, token, terminalUuid, deviceId).catch(() => 1);
      let utcIndexed = false;
      let utcOffset = 0;
      for (let page = 0; page < 15; page++) {
        const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
          {
            method: "searchVideoWithUTC",
            params: {
              playback: {
                search_video_with_utc: {
                  channel: 0,
                  start_time: startSec,
                  end_time: endSec,
                  start_index: utcOffset,
                  end_index: utcOffset + PAGE_SIZE - 1,
                  id: uid,
                },
              },
            },
          },
        ]);
        const utcRes = res[0];
        const utcCode = utcRes ? getErrorCode(utcRes) : -1;
        if (utcCode !== 0) {
          if (utcCode !== -71112 && utcCode !== -40210 && utcCode !== -40106) {
            hardErrorCode = hardErrorCode ?? utcCode;
          }
          break;
        }
        utcIndexed = true;
        const utcPlayback = ((utcRes?.result ?? {}) as Record<string, unknown>).playback as
          | Record<string, unknown>
          | undefined;
        const parsedUtc = parseVideoSegments(
          utcPlayback?.search_video_with_utc ?? utcPlayback?.search_video_results,
          offsetMs,
        );
        segments.push(...parsedUtc);
        utcOffset += parsedUtc.length;
        const hasMore = Number(utcPlayback?.to_be_continued ?? 0) === 1;
        if (parsedUtc.length === 0 || (!hasMore && parsedUtc.length < PAGE_SIZE)) break;
      }
      if (utcIndexed) {
        this.playbackIndexCache.set(deviceId, {
          clientId: uid,
          startSec,
          endSec,
          updatedAt: Date.now(),
        });
      }
    }

    if (events.length === 0 && segments.length === 0 && hardErrorCode !== null) {
      throw new TapoCloudError(
        this.deviceErrorMessage(hardErrorCode, "recordings_read_error"),
        hardErrorCode,
      );
    }

    // Remove generic event segments (type 2) that duplicate a richly-typed detection event.
    const dedupedSegments =
      events.length > 0
        ? segments.filter((seg) => {
            if (seg.type === 1) return true;
            return !events.some(
              (ev) => Math.abs(ev.start - seg.start) <= 2 && Math.abs(ev.end - seg.end) <= 2,
            );
          })
        : segments;

    events.sort((a, b) => b.start - a.start || b.end - a.end);
    dedupedSegments.sort((a, b) => b.start - a.start || b.end - a.end);

    return {
      date: dateYmd,
      timezone,
      clips: [...events, ...dedupedSegments],
      eventsCount: events.length,
      segmentsCount: dedupedSegments.length,
    };
  }

  /**
   * Allocates (or reuses) a camera playback client_id and ensures the camera has
   * indexed the requested time range via searchVideoWithUTC. Tapo C200 firmware
   * returns an immediate empty stream_status="finished" on CIPC playback unless
   * searchVideoWithUTC has been invoked with that client_id first.
   */
  async preparePlaybackSession(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    startSec: number,
    endSec: number,
    opts?: { forceRefresh?: boolean },
  ): Promise<{ clientId: number; fromCache: boolean }> {
    const now = Date.now();
    const cached = this.playbackIndexCache.get(deviceId);
    if (
      !opts?.forceRefresh &&
      cached &&
      now - cached.updatedAt < 10 * 60_000 &&
      cached.startSec <= startSec &&
      cached.endSec >= endSec
    ) {
      return { clientId: cached.clientId, fromCache: true };
    }

    const clientId =
      !opts?.forceRefresh && cached && now - cached.updatedAt < 10 * 60_000
        ? cached.clientId
        : await this.getPlaybackUserId(baseUrl, token, terminalUuid, deviceId).catch((err) => {
            console.warn("[playback] getPlaybackUserId failed, falling back to 1:", err);
            return 1;
          });

    const rangeStart = Math.max(0, startSec - 60);
    const rangeEnd = Math.max(rangeStart + 60, endSec + 60);
    try {
      await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
        {
          method: "searchVideoWithUTC",
          params: {
            playback: {
              search_video_with_utc: {
                channel: 0,
                start_time: rangeStart,
                end_time: rangeEnd,
                start_index: 0,
                end_index: 10,
                id: clientId,
              },
            },
          },
        },
      ]);
    } catch (err) {
      if (err instanceof TapoCloudError && err.isAuthError) throw err;
      // Older models that don't require searchVideoWithUTC can still proceed with clientId.
    }

    this.playbackIndexCache.set(deviceId, {
      clientId,
      startSec: rangeStart,
      endSec: rangeEnd,
      updatedAt: Date.now(),
    });
    return { clientId, fromCache: false };
  }

  async getPlaybackUserId(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
  ): Promise<number> {
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      { method: "getUserID", params: { system: { get_user_id: "null" } } },
    ]);
    const code = getErrorCode(res[0]);
    if (code !== 0) {
      throw new TapoCloudError(this.deviceErrorMessage(code, "playback_uid_error"), code);
    }
    const resObj = (res[0]?.result ?? {}) as Record<string, unknown>;
    const sysObj = (resObj.system as Record<string, unknown> | undefined)?.get_user_id as
      | Record<string, unknown>
      | undefined;
    const uid = Number(resObj.user_id ?? sysObj?.user_id ?? 0);
    if (!uid) throw new TapoCloudError(tServer(this.getLang(), "playback_uid_missing"));
    return uid;
  }

  async requestRelay(
    baseUrl: string,
    token: string,
    device: CameraMeta,
    options: { resolution: StreamQuality; streamType: 0 | 1 | 2; trackId?: string },
  ): Promise<RelayTarget> {
    const cipcBase = await this.ensureCipc(baseUrl, token);
    const playerId = randomUUID();
    const payload: Record<string, unknown> = {
      deviceId: device.deviceId,
      dataTimeoutCount: 0,
      cloudType: 2,
      deviceType: device.deviceType || "SMART.IPCAMERA",
      playerId,
      rootCaVer: "1",
      streamType: options.streamType,
      preConnection: 0,
      resolution: options.resolution,
    };
    if (options.streamType === 1) {
      payload.customParams = '{"audio_config":{"encode_type":"G711ulaw","sample_rate":"16"}}';
      if (options.trackId) payload.trackId = options.trackId;
    }

    const res = await fetch(`${cipcBase.replace(/\/+$/, "")}/v2/relay/request`, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": `Tapo_APP/Linux/${APP_VERSION}_Android/Android 14`,
        "X-Client-Id": playerId,
        "X-Source": "tapo-app",
        "X-Brand": "TPLINK",
        "X-Ca-Type": "cloud-self",
        "X-Request-Signature": randomUUID().replaceAll("-", "").slice(0, 10),
      },
      body: JSON.stringify(payload),
      tls: { ca: this.combinedCa },
      signal: AbortSignal.timeout(20_000),
    });

    const decoded = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = getErrorCode(decoded);
    if (res.status === 401 || err === -20651) {
      this.cipcUrl = "";
      throw new TapoCloudError(tServer(this.getLang(), "session_expired_token"), -20651, true);
    }
    if (err !== 0) {
      this.cipcUrl = "";
      throw new TapoCloudError(this.deviceErrorMessage(err, "relay_rejected_code"), err);
    }

    const info = (decoded.result ?? {}) as Record<string, unknown>;
    const relayUrl = String(info.relayUrl ?? "");
    const relayToken = String(info.relayToken ?? info.sessionToken ?? "");
    if (!relayUrl || !relayToken) {
      throw new TapoCloudError(tServer(this.getLang(), "relay_incomplete"));
    }

    const parsed = new URL(relayUrl.includes("://") ? relayUrl : `https://${relayUrl}`);
    const sep = parsed.search ? "&" : "?";
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 443),
      path: `${parsed.pathname || "/"}${parsed.search}${sep}retryTime=0`,
      relayToken,
      playerId,
      elbCookie: typeof info.elbCookie === "string" ? info.elbCookie : undefined,
    };
  }

  openRelayTls(
    target: RelayTarget,
    deviceModel: string,
    extra?: { trackId?: string; initialControlJson?: string },
  ): tls.TLSSocket {
    const sock = tls.connect({
      host: target.host,
      port: target.port,
      ca: this.combinedCa,
      servername: target.host,
    });

    attachSocketInactivityTimeout(sock, 22_000);
    sock.once("secureConnect", () => {
      const headers: Record<string, string> = {
        Host: target.host,
        "User-Agent": `Client=${APP_NAME} Android ${APP_VERSION}/1.3`,
        "Keep-Relay": "3600",
        Accept: "*/*",
        "Content-Type": "multipart/mixed;boundary=--client-stream-boundary--",
        "Content-Length": "9223372036854775807",
        "X-token": target.relayToken,
        "X-Client-Model": extra?.trackId ? "OnTapo" : deviceModel || "C200",
        "X-Client-UUID": target.playerId,
        "X-Redirect-Times": "0",
        "X-Pull-Mode": "2",
        "X-Version": "2.0",
        "X-Arrive-Latency": extra?.trackId ? "200" : "0",
        Connection: "Keep-alive",
      };
      if (extra?.trackId) {
        headers["X-Track-Id"] = extra.trackId;
        headers["X-Compete"] = "1";
      }
      if (target.elbCookie) headers.Cookie = target.elbCookie;

      let reqText = `POST ${target.path} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        reqText += `${k}: ${v}\r\n`;
      }
      reqText += "\r\n";

      sock.write(reqText, "ascii");
      if (extra?.initialControlJson) {
        const bodyBuf = Buffer.from(extra.initialControlJson, "utf8");
        const frame = Buffer.concat([
          Buffer.from(
            `----client-stream-boundary--\r\nContent-Type: application/json\r\nX-Data-Window-Size: 40\r\nContent-Length: ${bodyBuf.length}\r\n\r\n`,
            "ascii",
          ),
          bodyBuf,
          Buffer.from("\r\n", "ascii"),
        ]);
        sock.write(frame);
      }
    });

    return sock;
  }
}

function buildPsiTsPacket(pid: number, sectionHex: string): Buffer {
  const section = Buffer.from(sectionHex, "hex");
  let crc = 0xffffffff;
  for (const val of section) {
    crc ^= val << 24;
    for (let i = 0; i < 8; i++) {
      crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
    }
  }
  const pkt = Buffer.alloc(188, 0xff);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | ((pid >> 8) & 0x1f);
  pkt[2] = pid & 0xff;
  pkt[3] = 0x10;
  pkt[4] = 0x00;
  section.copy(pkt, 5);
  pkt.writeUInt32BE(crc, 5 + section.length);
  return pkt;
}

/**
 * Encodes 8 kHz mono G.711 A-law audio into Tapo's MPEG-TS backchannel format
 * (PAT + PMT stream_type 0x90 on PID 0x0100, stream_id 0xC0).
 */
export class TapoTalkEncoder {
  private counter = 0;
  private samples = 0;

  getPsiHeader(): Buffer {
    const pat = buildPsiTsPacket(0x0000, "00b00d0001c100000001f000");
    const pmt = buildPsiTsPacket(0x1000, "02b0120001c10000fffff00090e100f000");
    return Buffer.concat([pat, pmt]);
  }

  encodeAlaw(alaw: Uint8Array): Buffer {
    if (alaw.length === 0) return Buffer.alloc(0);
    const pts = Math.floor((this.samples * 90000) / 8000) % 0x200000000;
    const ptsHi = Math.floor(pts / 0x20000000);
    const pes = Buffer.allocUnsafe(14 + alaw.length);
    pes[0] = 0x00;
    pes[1] = 0x00;
    pes[2] = 0x01;
    pes[3] = 0xc0;
    pes.writeUInt16BE(alaw.length + 8, 4);
    pes[6] = 0x80;
    pes[7] = 0x80;
    pes[8] = 0x05;
    pes[9] = 0x21 | ((ptsHi & 0x07) << 1);
    pes[10] = Math.floor(pts / 0x400000) & 0xff;
    pes[11] = 0x01 | ((Math.floor(pts / 0x4000) & 0x7f) << 1);
    pes[12] = Math.floor(pts / 0x80) & 0xff;
    pes[13] = 0x01 | ((pts & 0x7f) << 1);
    Buffer.from(alaw).copy(pes, 14);

    const numPkts = Math.ceil(pes.length / 184);
    const out = Buffer.alloc(numPkts * 188, 0xff);
    for (let idx = 0; idx < numPkts; idx++) {
      const start = idx * 184;
      const slice = pes.subarray(start, start + 184);
      const base = idx * 188;
      out[base] = 0x47;
      out[base + 1] = idx === 0 ? 0x41 : 0x01;
      out[base + 2] = 0x00;
      if (slice.length === 184) {
        out[base + 3] = 0x10 | this.counter;
        slice.copy(out, base + 4);
      } else {
        const padding = 183 - slice.length;
        out[base + 3] = 0x30 | this.counter;
        out[base + 4] = padding;
        if (padding > 0) out[base + 5] = 0x00;
        slice.copy(out, base + 5 + padding);
      }
      this.counter = (this.counter + 1) & 0x0f;
    }

    this.samples += alaw.length;
    return out;
  }
}

export function writeRelayAudioFrame(sock: tls.TLSSocket, sessionId: string, tsBytes: Buffer): void {
  if (sock.destroyed || tsBytes.length === 0) return;
  const head = Buffer.from(
    `----client-stream-boundary--\r\nContent-Type: audio/mp2t\r\nX-If-Encrypt: 0\r\nX-Session-Id: ${sessionId}\r\nContent-Length: ${tsBytes.length}\r\n\r\n`,
    "ascii",
  );
  sock.write(Buffer.concat([head, tsBytes, Buffer.from("\r\n", "ascii")]));
}

export function writeRelaySequenceAck(
  sock: tls.TLSSocket,
  receivedSeq: number,
  sessionId?: string,
): void {
  if (sock.destroyed || !Number.isFinite(receivedSeq) || receivedSeq < 0) return;
  const body = Buffer.from(
    JSON.stringify({
      type: "notification",
      params: { event_type: "stream_sequence" },
    }),
    "utf8",
  );
  const sessionHeader = sessionId ? `X-Session-Id: ${sessionId}\r\n` : "";
  const head = Buffer.from(
    `----client-stream-boundary--\r\nX-Data-Received: ${receivedSeq}\r\n${sessionHeader}Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
    "ascii",
  );
  sock.write(Buffer.concat([head, body, Buffer.from("\r\n", "ascii")]));
}

export function attachSocketInactivityTimeout(
  sock: Pick<tls.TLSSocket, "on" | "once" | "emit">,
  timeoutMs: number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const bump = () => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      sock.emit("timeout");
    }, timeoutMs);
  };

  // Bun's native socket.setTimeout does not reset on incoming data, so reset manually.
  bump();
  sock.on("data", bump);
  sock.once("secureConnect", bump);
  sock.once("close", clear);
  sock.once("error", clear);
  return clear;
}

export function createRelayPartDemuxer(
  onPart: (headers: Record<string, string>, payload: Buffer) => void,
  getLang: () => ResolvedLanguage = () => "en",
) {
  let buf: Buffer = Buffer.alloc(0);
  let httpHeadParsed = false;
  let expectingBodyBytes = 0;
  let currentHeaders: Record<string, string> = {};
  let readingPartHeaders = false;

  const takeLine = (): Buffer | null => {
    const idx = buf.indexOf(0x0a);
    if (idx === -1) return null;
    const line = buf.subarray(0, idx + 1);
    buf = buf.subarray(idx + 1);
    return line;
  };

  return (chunk: Buffer): { httpStatus?: string; encrypted?: boolean } => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    let httpStatus: string | undefined;

    while (true) {
      if (expectingBodyBytes > 0) {
        if (buf.length < expectingBodyBytes) break;
        const payload = buf.subarray(0, expectingBodyBytes);
        buf = buf.subarray(expectingBodyBytes);
        expectingBodyBytes = 0;
        if (currentHeaders["x-if-encrypt"] === "1") {
          return { httpStatus, encrypted: true };
        }
        onPart(currentHeaders, payload);
        continue;
      }

      if (!httpHeadParsed) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const headText = buf.subarray(0, headerEnd).toString("latin1");
        buf = buf.subarray(headerEnd + 4);
        httpHeadParsed = true;
        httpStatus = headText.split("\r\n")[0]?.trim();
        if (httpStatus && !httpStatus.startsWith("HTTP/1.1 200") && !httpStatus.startsWith("HTTP/1.0 200")) {
          throw new TapoCloudError(tServer(getLang(), "relay_http_status", { status: httpStatus }));
        }
        continue;
      }

      if (!readingPartHeaders) {
        const line = takeLine();
        if (!line) break;
        if (line.includes("--device-stream-boundary--")) {
          readingPartHeaders = true;
          currentHeaders = {};
        }
        continue;
      }

      const line = takeLine();
      if (!line) break;
      const trimmed = line.toString("latin1").replace(/\r?\n$/, "");
      if (trimmed === "") {
        readingPartHeaders = false;
        const len = Number(currentHeaders["content-length"] ?? "0");
        if (Number.isFinite(len) && len > 0) {
          expectingBodyBytes = len;
        }
        continue;
      }
      const sep = trimmed.indexOf(":");
      if (sep > 0) {
        currentHeaders[trimmed.slice(0, sep).trim().toLowerCase()] = trimmed.slice(sep + 1).trim();
      }
    }

    return { httpStatus };
  };
}
