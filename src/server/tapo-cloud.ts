import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { DEVICE_ERROR_KEYS, type ServerMessageKey, tServer } from "../shared/i18n";
import type {
  CameraCapabilitySnapshot,
  CameraMeta,
  RecordingClip,
  RecordingDayResponse,
  ResolvedLanguage,
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

export class TapoCloudClient {
  readonly combinedCa: string[];
  private cipcUrl = "";
  private iotAppServer = "";
  private servicesSyncVersion: "v2" | "v1" = "v2";

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

  async servicesSync(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    requests: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const iotBase = await this.ensureIotServer(baseUrl, token);
    const body = JSON.stringify({
      inputParams: {
        requestData: {
          method: "multipleRequest",
          params: { requests },
        },
      },
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
    const responses = ((responseData.result ?? {}) as Record<string, unknown>).responses;
    if (!Array.isArray(responses)) {
      throw new TapoCloudError(tServer(this.getLang(), "camera_no_response"));
    }
    return responses as Array<Record<string, unknown>>;
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
        { method: "getSdCardFormatStatus", params: { harddisk_manage: { table: ["hd_info"] } } },
        { method: "getClockStatus", params: { system: { name: ["clock_status"] } } },
        { method: "getAudioConfig", params: { audio_config: { name: ["speaker", "microphone"] } } },
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
      const sdEntry = byMethod.get("getSdCardFormatStatus");
      const sdErr = sdEntry ? getErrorCode(sdEntry) : -1;
      const clockRes = byMethod.get("getClockStatus")?.result as Record<string, unknown> | undefined;
      const localTime = (
        (clockRes?.system as Record<string, unknown> | undefined)?.clock_status as Record<string, unknown> | undefined
      )?.local_time;
      const audioCfg = (byMethod.get("getAudioConfig")?.result as Record<string, unknown> | undefined)?.audio_config as
        | Record<string, unknown>
        | undefined;
      const micCfg = (audioCfg?.microphone ?? {}) as Record<string, unknown>;
      const spkCfg = (audioCfg?.speaker ?? {}) as Record<string, unknown>;

      return {
        deviceId,
        online: true,
        privacyOn: maskEnabled === "on" ? true : maskEnabled === "off" ? false : null,
        ptzSupported: Array.isArray(compList) && compList.some((c) => c.name === "ptz"),
        sdStatus: sdErr === 0 ? "ready" : sdErr === -40209 ? "missing_or_unformatted" : "unknown",
        sdErrorCode: sdErr !== 0 ? sdErr : undefined,
        cameraTime: typeof localTime === "string" ? localTime : undefined,
        resolutions: Array.isArray(mainCap.resolutions) ? mainCap.resolutions.map(String) : undefined,
        encodeTypes: Array.isArray(mainCap.encode_types) ? mainCap.encode_types.map(String) : undefined,
        micVolume: micCfg.volume !== undefined ? Number(micCfg.volume) : undefined,
        micMuted: micCfg.mute === "on",
        speakerVolume: spkCfg.volume !== undefined ? Number(spkCfg.volume) : undefined,
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
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      { method: "setMicrophoneVolume", params: { method: "set", audio_config: { microphone: mic } } },
    ]);
    const code = getErrorCode(res[0]);
    if (code !== 0) {
      throw new TapoCloudError(this.deviceErrorMessage(code, "mic_error_code"), code);
    }
  }

  async setPrivacyMode(
    baseUrl: string,
    token: string,
    terminalUuid: string,
    deviceId: string,
    enabled: boolean,
  ): Promise<boolean> {
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      {
        method: "setLensMaskConfig",
        params: { lens_mask: { lens_mask_info: { enabled: enabled ? "on" : "off" } } },
      },
    ]);
    const code = getErrorCode(res[0]);
    if (code !== 0) {
      throw new TapoCloudError(this.deviceErrorMessage(code, "privacy_error_code"), code);
    }
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
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      {
        method: "motorMove",
        params: { motor: { move: { x_coord: String(clampedX), y_coord: String(clampedY) } } },
      },
    ]);
    const code = getErrorCode(res[0]);
    if (code !== 0) {
      throw new TapoCloudError(this.deviceErrorMessage(code, "ptz_rejected_code"), code);
    }
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
    const res = await this.servicesSync(baseUrl, token, terminalUuid, deviceId, [
      {
        method: "getTimezone",
        params: { system: { name: ["basic"] } },
      },
      {
        method: "searchVideoOfDay",
        params: {
          playback: {
            search_video_utility: {
              channel: [0],
              date: cleanDate,
              start_index: 0,
              end_index: 999,
            },
          },
        },
      },
    ]);
    const tzRes = res[0];
    const searchRes = res[1];
    const searchCode = getErrorCode(searchRes);
    if (searchCode !== 0) {
      throw new TapoCloudError(
        this.deviceErrorMessage(searchCode, "recordings_read_error"),
        searchCode,
      );
    }

    const basic = (((tzRes?.result as Record<string, unknown>)?.system as Record<string, unknown>)?.basic ??
      {}) as Record<string, unknown>;
    const timezone = String(basic.timezone ?? "UTC+00:00");
    const offsetMs = parseTzOffsetMs(timezone);

    const playback = ((searchRes?.result ?? {}) as Record<string, unknown>).playback as
      | Record<string, unknown>
      | undefined;
    const rawItems = Array.isArray(playback?.search_video_results) ? playback.search_video_results : [];
    const clips: RecordingClip[] = [];
    for (const entry of rawItems) {
      if (!entry || typeof entry !== "object") continue;
      for (const val of Object.values(entry as Record<string, unknown>)) {
        if (!val || typeof val !== "object") continue;
        const item = val as Record<string, unknown>;
        const start = Number(item.startTime);
        const end = Number(item.endTime);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        clips.push({
          start,
          end,
          duration: end - start,
          type: Number(item.vedio_type ?? item.video_type ?? 0),
          startLocal: formatWithOffset(start, offsetMs),
          endLocal: formatWithOffset(end, offsetMs),
        });
      }
    }
    clips.sort((a, b) => a.start - b.start || a.end - b.end);
    return { date: dateYmd, timezone, clips };
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
    const uid = Number(((res[0]?.result ?? {}) as Record<string, unknown>).user_id ?? 0);
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
