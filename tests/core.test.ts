import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type tls from "node:tls";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { startTapoServer } from "../src/server/app";
import { buildAccessCookie, createAccessGuard } from "../src/server/auth-guard";
import { findFfmpegBinary, resolveRuntimeServerConfig } from "../src/server/config";
import {
  createFfmpegInstaller,
  downloadAndInstallFfmpeg,
  getFfmpegAssetName,
} from "../src/server/ffmpeg-installer";
import { MulawTsExtractor } from "../src/server/mulaw-extractor";
import { AppStorage } from "../src/server/storage";
import { StreamManager } from "../src/server/stream-manager";
import { remuxTapoTsBufferToMp4, streamSdRecordingMp4 } from "../src/server/playback";
import { resolveTimelineDropTarget } from "../src/shared/timeline";
import {
  attachSocketInactivityTimeout,
  createRelayPartDemuxer,
  dayRangeUtcSec,
  decodeDetectionEventKinds,
  extractSdCardDetails,
  parseDetectionListEntries,
  parseRecordPlanDay,
  parseVideoSegments,
  serializeRecordPlanDay,
  TapoCloudClient,
  TapoCloudError,
  TapoTalkEncoder,
} from "../src/server/tapo-cloud";
import { TsGopBuffer } from "../src/server/ts-gop-buffer";
import {
  compareSemver,
  createFallbackUpdater,
  normalizeReleaseRepo,
} from "../src/server/updater";
import { groupHealthMeta, isCameraOnline } from "../src/client/lib/api";
import { encodeFloat32ToAlaw8k, linearToAlaw } from "../src/client/lib/audio";
import {
  addEmulatedCamera,
  addEmulatedStore,
  applyEmulatedPreset,
  deleteEmulatedCamera,
  deleteEmulatedStore,
  EMPTY_EMULATED_STATE,
  isSimulatedCamera,
  isSimulatedStore,
  mergeDashboardWithEmulator,
  updateEmulatedCamera,
} from "../src/client/lib/debug-emulator";
import {
  normalizeLanguagePreference,
  resolveLanguage,
  SERVER_MESSAGES,
  tServer,
} from "../src/shared/i18n";
import type { AppUpdateState, CameraMeta, CameraTelemetry, DashboardBootstrap } from "../src/shared/types";

describe("AppStorage", () => {
  test("persists terminal uuid and session with 0600 permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapo-admin-test-"));
    try {
      const storage = new AppStorage(dir);
      const u1 = storage.getOrCreateTerminalUuid();
      const u2 = storage.getOrCreateTerminalUuid();
      expect(u1).toBe(u2);
      expect(u1.length).toBeGreaterThan(10);

      storage.saveSession({
        email: "user@example.com",
        baseUrl: "https://n-euw1-wap-gw.tplinkcloud.com",
        regionCode: "RU",
        token: "tok-123",
        terminalUuid: u1,
        terminalBound: true,
        savedAt: 1000,
      });

      const loaded = storage.loadSession();
      expect(loaded?.token).toBe("tok-123");
      if (process.platform !== "win32") {
        expect(statSync(storage.sessionPath).mode & 0o777).toBe(0o600);
      }

      storage.clearSession();
      expect(storage.loadSession()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createRelayPartDemuxer", () => {
  test("parses fragmented HTTP head and multipart MPEG-TS chunks", () => {
    const parts: Array<{ headers: Record<string, string>; payload: Buffer }> = [];
    const demux = createRelayPartDemuxer((headers, payload) => {
      parts.push({ headers, payload: Buffer.from(payload) });
    });

    const wire = Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: multipart/mixed\r\n\r\n", "ascii"),
      Buffer.from("----device-stream-boundary--\r\n", "ascii"),
      Buffer.from("Content-Type: video/mp2t\r\nX-If-Encrypt: 0\r\nContent-Length: 4\r\n\r\n", "ascii"),
      Buffer.from([0x47, 0x40, 0x00, 0x10]),
      Buffer.from("\r\n", "ascii"),
    ]);

    for (let i = 0; i < wire.length; i += 7) {
      const res = demux(wire.subarray(i, i + 7));
      expect(res.encrypted).toBeUndefined();
    }

    expect(parts).toHaveLength(1);
    expect(parts[0]!.headers["content-type"]).toBe("video/mp2t");
    expect(Array.from(parts[0]!.payload)).toEqual([0x47, 0x40, 0x00, 0x10]);
  });

  test("flags encrypted streams when x-if-encrypt is 1", () => {
    const demux = createRelayPartDemuxer(() => {});
    const wire = Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "ascii"),
      Buffer.from("----device-stream-boundary--\r\nContent-Length: 2\r\nX-If-Encrypt: 1\r\n\r\n", "ascii"),
      Buffer.from([0x01, 0x02]),
    ]);
    const res = demux(wire);
    expect(res.encrypted).toBe(true);
  });
});

describe("MulawTsExtractor", () => {
  test("extracts PES audio payload for stream_id 0xC0 across sync offset", () => {
    const pkt = Buffer.alloc(188, 0xff);
    pkt[0] = 0x47;
    pkt[1] = 0x40; // payload_unit_start_indicator = 1, pid = 0x45
    pkt[2] = 0x45;
    pkt[3] = 0x10; // payload only

    const mulawBytes = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const pesHeaderLen = 9;
    const totalLenAfter6 = 3 + mulawBytes.length;
    pkt[4] = 0x00;
    pkt[5] = 0x00;
    pkt[6] = 0x01;
    pkt[7] = 0xc0;
    pkt.writeUInt16BE(totalLenAfter6, 8);
    pkt[10] = 0x80;
    pkt[11] = 0x00;
    pkt[12] = 0x00;
    mulawBytes.copy(pkt, 4 + pesHeaderLen);

    const extractor = new MulawTsExtractor();
    const out = extractor.feed(Buffer.concat([Buffer.from([0xaa, 0xbb]), pkt]));
    expect(Array.from(out)).toEqual([0x11, 0x22, 0x33, 0x44]);
    expect(extractor.getEstimatedSampleRate()).toBe(16000);
  });

  test("estimates 8000 Hz vs 16000 Hz sample rate from PES PTS deltas", () => {
    const buildAudioPesTs = (sampleCount: number, pts: number): Buffer => {
      const pkt = Buffer.alloc(188, 0xff);
      pkt[0] = 0x47;
      pkt[1] = 0x40;
      pkt[2] = 0x45;
      pkt[3] = 0x10;
      const pesHeaderLen = 14;
      pkt[4] = 0x00;
      pkt[5] = 0x00;
      pkt[6] = 0x01;
      pkt[7] = 0xc0;
      pkt.writeUInt16BE(8 + sampleCount, 8);
      pkt[10] = 0x80;
      pkt[11] = 0x80;
      pkt[12] = 0x05;
      const ptsHi = Math.floor(pts / 0x40000000);
      pkt[13] = 0x21 | ((ptsHi & 0x07) << 1);
      pkt[14] = Math.floor(pts / 0x400000) & 0xff;
      pkt[15] = 0x01 | ((Math.floor(pts / 0x8000) & 0x7f) << 1);
      pkt[16] = Math.floor(pts / 0x80) & 0xff;
      pkt[17] = 0x01 | ((pts & 0x7f) << 1);
      pkt.fill(0x55, 4 + pesHeaderLen, 4 + pesHeaderLen + sampleCount);
      return pkt;
    };

    const ext8k = new MulawTsExtractor();
    // 10 x 20ms packets at 8000 Hz = 160 bytes per 1800 PTS ticks
    for (let i = 0; i < 12; i++) {
      ext8k.feed(buildAudioPesTs(160, 0x90000000 + i * 1800));
    }
    expect(ext8k.getEstimatedSampleRate()).toBe(8000);

    const ext16k = new MulawTsExtractor();
    // 12 x 10ms packets at 16000 Hz = 160 bytes per 900 PTS ticks -> wait 20ms = 160 bytes? No, 160 bytes at 16kHz = 10ms (900 ticks); make 25 packets = 250ms
    for (let i = 0; i < 25; i++) {
      ext16k.feed(buildAudioPesTs(160, 0x90000000 + i * 900));
    }
    expect(ext16k.getEstimatedSampleRate()).toBe(16000);
  });
});

describe("TsGopBuffer", () => {
  test("tracks PAT, PMT, keyframe GOP and aligns fragmented TS chunks", () => {
    const makePkt = (pid: number, pusi: boolean, payload: number[], rai = false): Buffer => {
      const p = Buffer.alloc(188, 0xff);
      p[0] = 0x47;
      p[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
      p[2] = pid & 0xff;
      if (rai) {
        p[3] = 0x30;
        p[4] = 1;
        p[5] = 0x40;
        Buffer.from(payload).copy(p, 6);
      } else {
        p[3] = 0x10;
        Buffer.from(payload).copy(p, 4);
      }
      return p;
    };

    // PAT pointing program 1 -> PMT PID 0x1000
    const pat = makePkt(0x0000, true, [0x00, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00]);
    // PMT mapping H.264 stream_type 0x1b -> PID 0x0100
    const pmt = makePkt(0x1000, true, [
      0x00, 0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00,
      0x1b, 0xe1, 0x00, 0xf0, 0x00,
    ]);
    const staleDelta = makePkt(0x0100, false, [0x00, 0x00, 0x00, 0x01, 0x41]);
    const idrStart = makePkt(0x0100, true, [0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x67], true);
    const idrCont = makePkt(0x0100, false, [0xaa, 0xbb, 0xcc]);

    const gop = new TsGopBuffer();
    const wire = Buffer.concat([pat, pmt, staleDelta, idrStart, idrCont]);
    const alignedA = gop.feed(wire.subarray(0, 200));
    const alignedB = gop.feed(wire.subarray(200));

    expect(alignedA.length).toBe(188);
    expect((alignedA.length + alignedB.length) % 188).toBe(0);
    expect(alignedA.length + alignedB.length).toBe(wire.length);

    const boot = gop.getBootstrapChunk();
    expect(boot).not.toBeNull();
    // Should include PAT + PMT + IDR start + IDR cont (dropped staleDelta)
    expect(boot!.length).toBe(4 * 188);
  });
});

describe("isCameraOnline", () => {
  const baseCam: CameraMeta = {
    deviceId: "cam-1",
    alias: "Tapo C200",
    deviceModel: "C200",
    deviceName: "C200 5.0",
    deviceHwVer: "5.0",
    fwVer: "1.5.7",
    deviceRegion: "eu-west-1",
    accessPlatform: "IOT",
    appServerUrl: "https://n-euw1-wap-gw.tplinkcloud.com",
    deviceType: "SMART.IPCAMERA",
    rawStatus: 0,
  };

  test("treats IOT cameras with rawStatus=0 as online unless telemetry says offline", () => {
    expect(isCameraOnline(baseCam, undefined)).toBe(true);
    const streaming: CameraTelemetry = {
      deviceId: "cam-1",
      status: "streaming",
      mode: "grid_low",
      resolution: "VGA",
      gridFps: 1,
      subscribers: 1,
      audioSubscribers: 0,
      kbps: 500,
      bytesTotal: 1024,
      connectLatencyMs: 500,
      lastFrameAt: Date.now(),
      reconnects: 0,
      lastError: null,
    };
    expect(isCameraOnline(baseCam, streaming)).toBe(true);
    expect(isCameraOnline(baseCam, { ...streaming, status: "offline" })).toBe(false);
    expect(isCameraOnline({ ...baseCam, accessPlatform: "WAP", rawStatus: 0 }, undefined)).toBe(false);
  });
});

describe("attachSocketInactivityTimeout", () => {
  test("resets on incoming data and emits timeout only after inactivity", async () => {
    const emitter = new EventEmitter();
    let timeouts = 0;
    emitter.on("timeout", () => {
      timeouts += 1;
    });

    const clear = attachSocketInactivityTimeout(
      emitter as unknown as Parameters<typeof attachSocketInactivityTimeout>[0],
      60,
    );
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(25);
      emitter.emit("data", Buffer.from([1]));
    }
    expect(timeouts).toBe(0);

    await Bun.sleep(90);
    expect(timeouts).toBe(1);
    clear();
  });
});

describe("TapoTalkEncoder & Media Storage", () => {
  test("encodes PAT/PMT PSI and 188-byte aligned PCMA MPEG-TS packets", () => {
    const enc = new TapoTalkEncoder();
    const hdr = enc.getPsiHeader();
    expect(hdr.length).toBe(376);
    expect(hdr[0]).toBe(0x47);
    expect(hdr[188]).toBe(0x47);

    const alaw = new Uint8Array(320).fill(0xd5);
    const ts = enc.encodeAlaw(alaw);
    expect(ts.length % 188).toBe(0);
    expect(ts[0]).toBe(0x47);
    expect(ts[1]).toBe(0x41);
    expect(ts[4]).toBe(0x00);
    expect(ts[5]).toBe(0x00);
    expect(ts[6]).toBe(0x01);
    expect(ts[7]).toBe(0xc0);
  });

  test("encodes Float32 PCM to 8kHz A-law", () => {
    expect(linearToAlaw(0)).toBe(0xd5);
    const input = new Float32Array(480); // 10ms at 48kHz -> 80 samples at 8kHz
    const out = encodeFloat32ToAlaw8k(input, 48000);
    expect(out.length).toBe(80);
  });

  test("persists and deletes gallery media items and drops legacy seeded store", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapo-media-test-"));
    try {
      const storage = new AppStorage(dir);
      storage.saveWorkspace({
        stores: [
          {
            id: "legacy",
            name: "Точка 1",
            address: "Тестовая точка",
            networkKind: "wired",
            cameraIds: [],
            createdAt: 1,
          },
        ],
        storeMeta: {},
        roomOverrides: {},
        customNames: {},
        cameraOrientations: {},
        settings: {
          gridFps: 30,
          gridResolution: "VGA",
          gridTransport: "webcodecs",
          autoCycleSeconds: 0,
          language: "auto",
        },
      });
      const loaded = storage.loadWorkspace();
      expect(loaded.stores).toHaveLength(0);
      expect(loaded.settings.gridFps).toBe(30);

      const saved = storage.saveMediaFile(
        {
          kind: "snapshot",
          deviceId: "dev-1",
          cameraName: "Касса",
          storeName: "Кабинет",
          mimeType: "image/jpeg",
        },
        "jpg",
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      );
      expect(storage.listMedia()).toHaveLength(1);
      expect(storage.getMediaItem(saved.id)?.item.filename.endsWith(".jpg")).toBe(true);
      expect(storage.deleteMediaItem(saved.id)).toBe(true);
      expect(storage.listMedia()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("debug emulator generates, adds, deletes, and merges cameras and groups cleanly", () => {
    const preset = applyEmulatedPreset(EMPTY_EMULATED_STATE, 9, 4, []);
    expect(preset.cameras).toHaveLength(9);
    expect(preset.stores).toHaveLength(4);
    expect(isSimulatedCamera(preset.cameras[0]!.deviceId)).toBe(true);
    expect(isSimulatedStore(preset.stores[0]!.id)).toBe(true);

    const addedStore = addEmulatedStore(preset, { name: "Новый цех", initialCameras: 2 });
    expect(addedStore.nextState.stores).toHaveLength(5);
    expect(addedStore.nextState.cameras).toHaveLength(11);

    const addedCam = addEmulatedCamera(addedStore.nextState, {
      name: "Турникет",
      storeId: addedStore.createdStore.id,
      status: "error",
    });
    expect(addedCam.nextState.cameras).toHaveLength(12);

    const merged = mergeDashboardWithEmulator([], [], {}, addedCam.nextState);
    expect(merged.cameras).toHaveLength(12);
    expect(merged.stores).toHaveLength(5);
    expect(merged.telemetry[addedCam.createdCamera.deviceId]?.status).toBe("error");
    expect(
      merged.stores.find((s) => s.id === addedStore.createdStore.id)?.cameraIds,
    ).toHaveLength(3);

    const afterDelCam = deleteEmulatedCamera(addedCam.nextState, addedCam.createdCamera.deviceId);
    expect(afterDelCam.cameras).toHaveLength(11);

    const afterDelStore = deleteEmulatedStore(afterDelCam, addedStore.createdStore.id, true);
    expect(afterDelStore.stores).toHaveLength(4);
    expect(afterDelStore.cameras).toHaveLength(9);
  });

  test("groupHealthMeta reports amber when partial cameras work and green only when all work", () => {
    expect(groupHealthMeta(0, 0).state).toBe("empty");
    expect(groupHealthMeta(2, 2).state).toBe("all");
    expect(groupHealthMeta(2, 2).dotClass).toContain("emerald");

    const partial = groupHealthMeta(1, 2);
    expect(partial.state).toBe("partial");
    expect(partial.dotClass).toContain("amber");
    expect(partial.textClass).toContain("amber");

    const none = groupHealthMeta(0, 2);
    expect(none.state).toBe("none");
    expect(none.dotClass).toContain("red");
  });
});

describe("i18n, access guard, config & server", () => {
  test("shared i18n resolves auto/en/ru and maintains key parity", () => {
    expect(normalizeLanguagePreference("ru")).toBe("ru");
    expect(normalizeLanguagePreference("en")).toBe("en");
    expect(normalizeLanguagePreference("invalid")).toBe("auto");

    expect(resolveLanguage("auto", "ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(resolveLanguage("auto", "en-US,en;q=0.9")).toBe("en");
    expect(resolveLanguage("en", "ru-RU")).toBe("en");
    expect(resolveLanguage("ru", "en-US")).toBe("ru");

    expect(Object.keys(SERVER_MESSAGES.en).sort()).toEqual(
      Object.keys(SERVER_MESSAGES.ru).sort(),
    );
    expect(tServer("en", "talk_connected", { alias: "Hall" })).toBe("Hall: talkback connected");
    expect(tServer("ru", "talk_connected", { alias: "Зал" })).toBe("Зал: голосовая связь открыта");
  });

  test("access guard signs cookies, validates Bearer tokens, and sets Secure only on HTTPS", () => {
    const disabled = createAccessGuard("");
    expect(disabled.required).toBe(false);
    expect(disabled.isRequestAuthorized(new Request("http://127.0.0.1/api/bootstrap"))).toBe(true);

    const guard = createAccessGuard("super-secret-pass");
    expect(guard.required).toBe(true);
    expect(guard.verifyPassword("super-secret-pass")).toBe(true);
    expect(guard.verifyPassword("wrong")).toBe(false);

    const httpReq = new Request("http://127.0.0.1:3456/api/access/unlock");
    const httpCookieHeader = guard.issueCookieHeader(httpReq);
    expect(httpCookieHeader).toContain("HttpOnly");
    expect(httpCookieHeader).toContain("SameSite=Lax");
    expect(httpCookieHeader).not.toContain("Secure");

    const httpsCookieHeader = buildAccessCookie(
      new Request("http://127.0.0.1:3456/api/access/unlock", {
        headers: { "x-forwarded-proto": "https" },
      }),
      "tok",
      60,
    );
    expect(httpsCookieHeader).toContain("; Secure");

    const cookiePair = httpCookieHeader.split(";")[0]!;
    expect(
      guard.isRequestAuthorized(
        new Request("http://127.0.0.1/api/settings", { headers: { cookie: cookiePair } }),
      ),
    ).toBe(true);
    expect(
      guard.isRequestAuthorized(
        new Request("http://127.0.0.1/api/settings", {
          headers: { authorization: "Bearer super-secret-pass" },
        }),
      ),
    ).toBe(true);
    expect(
      guard.isRequestAuthorized(new Request("http://127.0.0.1/api/settings")),
    ).toBe(false);
  });

  test("config resolves runtime defaults and directDataDir storage option", () => {
    const cfg = resolveRuntimeServerConfig();
    expect(typeof cfg.hostname).toBe("string");
    expect(typeof cfg.port).toBe("number");

    const dir = mkdtempSync(join(tmpdir(), "tapo-direct-data-"));
    try {
      const dummyFfmpeg = join(dir, "custom-ffmpeg");
      writeFileSync(dummyFfmpeg, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(findFfmpegBinary(dummyFfmpeg)).toBe(dummyFfmpeg);

      const storage = new AppStorage(dir, { directDataDir: true });
      expect(storage.dataDir).toBe(dir);
      expect(storage.loadWorkspace().settings.language).toBe("auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("startTapoServer enforces access guard, persists language, and serves static assets safely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapo-server-int-"));
    const staticDir = join(dir, "public");
    const dataDir = join(dir, "data");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Tapo Test</title>", "utf8");
    writeFileSync(join(staticDir, "app.1234abcd.js"), "console.log('ok');", "utf8");

    const running = startTapoServer({
      hostname: "127.0.0.1",
      port: 0,
      dataDir,
      directDataDir: true,
      staticDir,
      accessPassword: "gate-password",
      debugEmulatorEnabled: true,
      desktopApp: true,
    });

    try {
      const healthRes = await fetch(`${running.url}/api/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ ok: true });

      const staticRes = await fetch(`${running.url}/`);
      expect(staticRes.status).toBe(200);
      expect(staticRes.headers.get("cache-control")).toBe("no-cache");
      expect(await staticRes.text()).toContain("Tapo Test");

      const assetRes = await fetch(`${running.url}/app.1234abcd.js`);
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get("cache-control")).toContain("immutable");

      const lockedBootRes = await fetch(`${running.url}/api/bootstrap`);
      expect(lockedBootRes.status).toBe(200);
      const lockedBoot = (await lockedBootRes.json()) as DashboardBootstrap;
      expect(lockedBoot.accessRequired).toBe(true);
      expect(lockedBoot.accessUnlocked).toBe(false);
      expect(lockedBoot.cameras).toEqual([]);
      expect(lockedBoot.capabilities.desktopApp).toBe(true);
      expect(lockedBoot.capabilities.debugEmulatorEnabled).toBe(true);

      const blockedRes = await fetch(`${running.url}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Tapo-Lang": "ru" },
        body: JSON.stringify({ language: "ru" }),
      });
      expect(blockedRes.status).toBe(401);
      const blockedJson = (await blockedRes.json()) as { code?: string; error?: string };
      expect(blockedJson.code).toBe("ACCESS_LOCKED");
      expect(blockedJson.error).toBe(tServer("ru", "access_locked"));

      const badUnlock = await fetch(`${running.url}/api/access/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tapo-Lang": "en" },
        body: JSON.stringify({ password: "nope" }),
      });
      expect(badUnlock.status).toBe(401);

      const goodUnlock = await fetch(`${running.url}/api/access/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "gate-password" }),
      });
      expect(goodUnlock.status).toBe(200);
      const cookie = goodUnlock.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toContain("tapo_access=");

      const patchLang = await fetch(`${running.url}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: cookie! },
        body: JSON.stringify({ language: "ru" }),
      });
      expect(patchLang.status).toBe(200);

      const unlockedBootRes = await fetch(`${running.url}/api/bootstrap`, {
        headers: { cookie: cookie! },
      });
      const unlockedBoot = (await unlockedBootRes.json()) as DashboardBootstrap;
      expect(unlockedBoot.accessUnlocked).toBe(true);
      expect(unlockedBoot.settings.language).toBe("ru");

      const lockRes = await fetch(`${running.url}/api/access/lock`, {
        method: "POST",
        headers: { cookie: cookie! },
      });
      expect(lockRes.status).toBe(200);
      expect(lockRes.headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Updater & Release Helpers", () => {
  test("compares semver versions including prereleases and v prefixes", () => {
    expect(compareSemver("v0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("0.1.0", "v0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "0.1.1")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
  });

  test("normalizes release repositories with safe default fallback", () => {
    expect(normalizeReleaseRepo("https://github.com/octo/repo.git")).toBe("octo/repo");
    expect(normalizeReleaseRepo("/sabraman/tapo-admin/")).toBe("sabraman/tapo-admin");
    expect(normalizeReleaseRepo("invalid")).toBe("sabraman/tapo-admin");
    expect(normalizeReleaseRepo("")).toBe("sabraman/tapo-admin");
  });

  test("createFallbackUpdater handles 404, newer releases, up-to-date, and network errors", async () => {
    const u404 = createFallbackUpdater({
      currentVersion: "0.1.0",
      fetchImpl: (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch,
    });
    const res404 = await u404.checkForUpdate();
    expect(res404.phase).toBe("up-to-date");
    expect(res404.canAutoUpdate).toBe(false);
    expect(res404.latestVersion).toBe("0.1.0");

    const uNewer = createFallbackUpdater({
      currentVersion: "0.1.0",
      fetchImpl: (async () =>
        Response.json({
          tag_name: "v0.2.0",
          html_url: "https://github.com/sabraman/tapo-admin/releases/tag/v0.2.0",
        })) as unknown as typeof fetch,
    });
    const resNewer = await uNewer.checkForUpdate();
    expect(resNewer.phase).toBe("available");
    expect(resNewer.latestVersion).toBe("0.2.0");
    expect(resNewer.canAutoUpdate).toBe(false);
    expect(resNewer.releaseUrl).toBe("https://github.com/sabraman/tapo-admin/releases/tag/v0.2.0");

    const uSame = createFallbackUpdater({
      currentVersion: "0.2.0",
      fetchImpl: (async () =>
        Response.json({
          tag_name: "v0.2.0",
          html_url: "https://github.com/sabraman/tapo-admin/releases/tag/v0.2.0",
        })) as unknown as typeof fetch,
    });
    const resSame = await uSame.checkForUpdate();
    expect(resSame.phase).toBe("up-to-date");

    const uErr = createFallbackUpdater({
      currentVersion: "0.1.0",
      fetchImpl: (async () => new Response("Server Error", { status: 500 })) as unknown as typeof fetch,
    });
    const resErr = await uErr.checkForUpdate();
    expect(resErr.phase).toBe("error");
    expect(resErr.error).toContain("HTTP 500");
  });

  test("server update endpoints respect access guard and updater bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapo-updater-server-"));
    let state: AppUpdateState = {
      currentVersion: "0.1.0",
      phase: "idle",
      canAutoUpdate: true,
      releaseUrl: "https://github.com/sabraman/tapo-admin/releases/latest",
    };

    const mockUpdater = {
      getState: () => ({ ...state }),
      checkForUpdate: async () => {
        state = {
          ...state,
          phase: "available",
          latestVersion: "0.2.0",
          checkedAt: Date.now(),
        };
        return { ...state };
      },
      applyUpdate: async () => {
        state = {
          ...state,
          phase: "downloading",
          progress: 25,
        };
        return { ...state };
      },
    };

    const running = startTapoServer({
      hostname: "127.0.0.1",
      port: 0,
      dataDir: dir,
      directDataDir: true,
      accessPassword: "gate-password",
      appVersion: "0.1.0",
      updater: mockUpdater,
    });

    try {
      const blocked = await fetch(`${running.url}/api/updates`);
      expect(blocked.status).toBe(401);

      const bootLockedRes = await fetch(`${running.url}/api/bootstrap`);
      const bootLocked = (await bootLockedRes.json()) as DashboardBootstrap;
      expect(bootLocked.capabilities.appVersion).toBe("0.1.0");
      expect(bootLocked.updateState.phase).toBe("idle");

      const unlockRes = await fetch(`${running.url}/api/access/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "gate-password" }),
      });
      const cookie = unlockRes.headers.get("set-cookie")!.split(";")[0]!;

      const checkRes = await fetch(`${running.url}/api/updates/check`, {
        method: "POST",
        headers: { cookie },
      });
      expect(checkRes.status).toBe(200);
      const checked = (await checkRes.json()) as AppUpdateState;
      expect(checked.phase).toBe("available");
      expect(checked.latestVersion).toBe("0.2.0");

      const applyRes = await fetch(`${running.url}/api/updates/apply`, {
        method: "POST",
        headers: { cookie },
      });
      expect(applyRes.status).toBe(200);
      const applied = (await applyRes.json()) as AppUpdateState;
      expect(applied.phase).toBe("downloading");
      expect(applied.progress).toBe(25);
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("server returns 400 when auto-update apply is unsupported in fallback mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapo-updater-fallback-"));
    const running = startTapoServer({
      hostname: "127.0.0.1",
      port: 0,
      dataDir: dir,
      directDataDir: true,
      updater: createFallbackUpdater({
        currentVersion: "0.1.0",
        fetchImpl: (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch,
      }),
    });

    try {
      const res = await fetch(`${running.url}/api/updates/apply`, {
        method: "POST",
        headers: { "X-Tapo-Lang": "en" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe(tServer("en", "update_auto_unsupported"));
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SD events, record plan, SD info & audio muxing", () => {
  test("computes UTC day bounds for camera timezone and parses detection list entries", () => {
    const { startSec, endSec } = dayRangeUtcSec("2026-11-26", 3 * 3600 * 1000);
    expect(endSec - startSec).toBe(86399);
    expect(startSec).toBe(Math.floor(Date.UTC(2026, 10, 25, 21, 0, 0) / 1000));

    const events = parseDetectionListEntries(
      [
        {
          start_time: startSec + 3600,
          end_time: startSec + 3624,
          alarm_type: 6,
          events_1: 524288 | 2,
        },
        {
          search_detection_list_2: {
            start_time: startSec + 7200,
            end_time: startSec + 7215,
            alarm_type: 3,
          },
        },
        {
          startTime: startSec + 9000,
          endTime: startSec + 9010,
          events_1: { type: "motion", value: 2 },
        },
      ],
      3 * 3600 * 1000,
    );

    expect(events).toHaveLength(3);
    expect(events[0]!.source).toBe("event");
    expect(events[0]!.eventKinds).toEqual(["person", "motion"]);
    expect(events[0]!.startLocal).toBe("2026-11-26 01:00:00");
    expect(events[1]!.eventKinds).toEqual(["tamper"]);
    expect(events[2]!.eventKinds).toEqual(["motion"]);

    const decodedFallback = decodeDetectionEventKinds({});
    expect(decodedFallback.kinds).toEqual(["event"]);
  });

  test("parses searchVideoOfDay and searchVideoWithUTC segments", () => {
    const segs = parseVideoSegments(
      [
        { search_video_results_1: { startTime: 1700000000, endTime: 1700001800, vedio_type: 1 } },
        { start_time: 1700002000, end_time: 1700002030, video_type: 2 },
      ],
      0,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]!.eventKinds).toEqual(["continuous"]);
    expect(segs[1]!.eventKinds).toEqual(["event"]);
    expect(segs[0]!.source).toBe("segment");
  });

  test("round-trips SD recording plan day segments", () => {
    const parsed = parseRecordPlanDay('["0800-2200:2","0000-0800:1","invalid","2200-1800:1"]');
    expect(parsed).toEqual([
      { start: "0000", end: "0800", mode: 1 },
      { start: "0800", end: "2200", mode: 2 },
    ]);
    expect(serializeRecordPlanDay(parsed)).toBe('["0000-0800:1","0800-2200:2"]');
    expect(serializeRecordPlanDay([])).toBe("[]");
  });

  test("extracts SD card capacity and status from harddisk_manage hd_info", () => {
    const ready = extractSdCardDetails(
      {
        error_code: 0,
        result: {
          harddisk_manage: {
            hd_info: [
              {
                hd_info_1: {
                  status: "normal",
                  total_space: "58.23 GB",
                  free_space: "40.10 GB",
                  percent: "69",
                  rw_attr: "rw",
                },
              },
            ],
          },
        },
      },
      {
        error_code: 0,
        result: {
          harddisk_manage: {
            harddisk: { loop: "on" },
          },
        },
      },
    );
    expect(ready.sdStatus).toBe("ready");
    expect(ready.sdCard?.freeSpace).toBe("40.10 GB");
    expect(ready.sdCard?.loopRecordEnabled).toBe(true);

    const paramErr = extractSdCardDetails({ error_code: -40209 });
    expect(paramErr.sdStatus).toBe("unknown");
    expect(paramErr.sdErrorCode).toBe(-40209);

    const emptyDisk = extractSdCardDetails({
      error_code: 0,
      result: { harddisk_manage: { hd_info: [] } },
    });
    expect(emptyDisk.sdStatus).toBe("missing_or_unformatted");

    const unformattedDisk = extractSdCardDetails({
      error_code: 0,
      result: {
        harddisk_manage: {
          hd_info: [{ hd_info_1: { status: "unformatted" } }],
        },
      },
    });
    expect(unformattedDisk.sdStatus).toBe("missing_or_unformatted");
  });

  test("getCapabilitySnapshot uses getSdCardStatus, triggerManualAlarm uses valid passthrough payloads, and setAlarmConfig prefers setAlertConfig", async () => {
    const cfg = resolveRuntimeServerConfig();
    const client = new TapoCloudClient(cfg.certPath!);

    const sentRawPayloads: Array<Record<string, unknown>> = [];
    const sentMethods: string[] = [];

    // 1. Verify getCapabilitySnapshot requests getSdCardStatus (not getSdCardFormatStatus)
    (client as unknown as { servicesSync: TapoCloudClient["servicesSync"] }).servicesSync = async (
      _baseUrl,
      _token,
      _terminalUuid,
      _deviceId,
      requests,
    ) => {
      for (const req of requests) {
        sentMethods.push(String(req.method));
      }
      return [
        { method: "getVideoCapability", error_code: 0, result: { video_capability: { main: {} } } },
        {
          method: "getAppComponentList",
          error_code: 0,
          result: { app_component: { app_component_list: [{ name: "ptz" }] } },
        },
        { method: "getLensMaskConfig", error_code: 0, result: { lens_mask: { lens_mask_info: { enabled: "off" } } } },
        {
          method: "getSdCardStatus",
          error_code: 0,
          result: {
            harddisk_manage: {
              hd_info: [{ hd_info_1: { status: "normal", total_space: "58.23 GB", free_space: "12.0 GB" } }],
            },
          },
        },
        { method: "getAlertConfig", error_code: 0, result: { msg_alarm: { chn1_msg_alarm_info: { enabled: "off" } } } },
      ];
    };

    const snap = await client.getCapabilitySnapshot("https://example.test", "tok", "uuid", "dev1");
    expect(sentMethods).toContain("getSdCardStatus");
    expect(sentMethods).not.toContain("getSdCardFormatStatus");
    expect(snap.sdStatus).toBe("ready");
    expect(snap.sdCard?.totalSpace).toBe("58.23 GB");

    // 2. Verify triggerManualAlarm sends Style-III / Style-II payloads with `params` and falls back from PASSTHROUGH_PAYLOAD_FORMAT_CHECK_FAIL
    (client as unknown as { servicesSyncRaw: TapoCloudClient["servicesSyncRaw"] }).servicesSyncRaw = async (
      _baseUrl,
      _token,
      _terminalUuid,
      _deviceId,
      requestData,
    ) => {
      sentRawPayloads.push(requestData);
      expect("params" in requestData).toBe(true);
      expect("msg_alarm" in requestData).toBe(false);
      const reqs = ((requestData.params as Record<string, unknown> | undefined)?.requests ?? []) as Array<
        Record<string, unknown>
      >;
      if (requestData.method === "multipleRequest" && reqs[0]?.method === "do") {
        throw new TapoCloudError("[trace.1] PASSTHROUGH_PAYLOAD_FORMAT_CHECK_FAIL", 400);
      }
      if (requestData.method === "multipleRequest" && reqs[0]?.method === "startManualAlarm") {
        return { error_code: 0, result: { responses: [{ method: "startManualAlarm", error_code: -40210 }] } };
      }
      if (requestData.method === "multipleRequest" && reqs[0]?.method === "getAlertConfig") {
        return {
          error_code: 0,
          result: {
            responses: [
              { method: "getAlertConfig", error_code: 0, result: { msg_alarm: { chn1_msg_alarm_info: { alarm_type: "2" } } } },
            ],
          },
        };
      }
      if (requestData.method === "multipleRequest" && reqs[0]?.method === "testUsrDefAudio") {
        return { error_code: 0, result: { responses: [{ method: "testUsrDefAudio", error_code: 0 }] } };
      }
      return { error_code: 0, result: { responses: [{ method: String(reqs[0]?.method ?? "do"), error_code: 0 }] } };
    };
    delete (client as unknown as { servicesSync?: unknown }).servicesSync;

    await client.triggerManualAlarm("https://example.test", "tok", "uuid", "dev1", "start");
    const lastPayload = sentRawPayloads[sentRawPayloads.length - 1]!;
    expect(lastPayload.method).toBe("multipleRequest");
    const lastReq = ((lastPayload.params as Record<string, unknown>).requests as Array<Record<string, unknown>>)[0]!;
    expect(lastReq.method).toBe("testUsrDefAudio");
    expect((lastReq.params as Record<string, unknown>).msg_alarm).toEqual({
      test_usr_def_audio: { force: "1", id: "2" },
    });

    // 3. Verify auth errors abort immediately without continuing fallback attempts
    let authCalls = 0;
    (client as unknown as { servicesSyncRaw: TapoCloudClient["servicesSyncRaw"] }).servicesSyncRaw = async () => {
      authCalls += 1;
      throw new TapoCloudError("Session expired", -20651, true);
    };
    await expect(
      client.triggerManualAlarm("https://example.test", "tok", "uuid", "dev1", "stop"),
    ).rejects.toThrow("Session expired");
    expect(authCalls).toBe(1);

    // 4. Verify setAlarmConfig prefers setAlertConfig and syncs sound_alarm_enabled when present
    const alarmWrites: Array<Record<string, unknown>> = [];
    (client as unknown as { servicesSyncRaw: TapoCloudClient["servicesSyncRaw"] }).servicesSyncRaw = async (
      _baseUrl,
      _token,
      _terminalUuid,
      _deviceId,
      requestData,
    ) => {
      const reqs = ((requestData.params as Record<string, unknown>).requests ?? []) as Array<
        Record<string, unknown>
      >;
      if (reqs[0]?.method === "getAlertConfig") {
        return {
          error_code: 0,
          result: {
            responses: [
              {
                method: "getAlertConfig",
                error_code: 0,
                result: {
                  msg_alarm: {
                    chn1_msg_alarm_info: {
                      enabled: "off",
                      sound_alarm_enabled: "off",
                      light_alarm_enabled: "off",
                      alarm_mode: ["sound"],
                    },
                  },
                },
              },
            ],
          },
        };
      }
      alarmWrites.push(reqs[0]!);
      return { error_code: 0, result: { responses: [{ method: String(reqs[0]?.method), error_code: 0 }] } };
    };

    await client.setAlarmConfig("https://example.test", "tok", "uuid", "dev1", { enabled: true });
    expect(alarmWrites).toHaveLength(1);
    expect(alarmWrites[0]!.method).toBe("setAlertConfig");
    const writtenInfo = (
      (alarmWrites[0]!.params as Record<string, unknown>).msg_alarm as Record<string, unknown>
    ).chn1_msg_alarm_info as Record<string, unknown>;
    expect(writtenInfo.enabled).toBe("on");
    expect(writtenInfo.sound_alarm_enabled).toBe("on");
    expect(writtenInfo.light_alarm_enabled).toBe("off");
  });

  test("remuxTapoTsBufferToMp4 muxes video + private Tapo 0xC0 mulaw audio into MP4 when ffmpeg is available", async () => {
    const bin = findFfmpegBinary();
    if (!bin) return;
    const { spawnSync } = await import("node:child_process");
    const vid = spawnSync(bin, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=1:size=160x120:rate=10",
      "-c:v",
      "libx264",
      "-f",
      "mpegts",
      "pipe:1",
    ]);
    expect(vid.status).toBe(0);
    const tsVideoOnly = Buffer.from(vid.stdout);

    // Silent TS should remux cleanly
    const silentMp4 = await remuxTapoTsBufferToMp4(bin, tsVideoOnly);
    expect(silentMp4.length).toBeGreaterThan(200);

    // Build a synthetic Tapo 0xC0 G.711 u-law audio PES packet on PID 0x0045
    const enc = new TapoTalkEncoder();
    const audioTs = enc.encodeAlaw(new Uint8Array(1600).fill(0xff));
    // Rewrite PID 0x0100 -> 0x0045 to mimic camera private audio PID
    for (let off = 0; off < audioTs.length; off += 188) {
      audioTs[off + 1] = (audioTs[off + 1]! & 0xe0) | 0x00;
      audioTs[off + 2] = 0x45;
    }

    const combined = Buffer.concat([tsVideoOnly, audioTs]);
    const muxedMp4 = await remuxTapoTsBufferToMp4(bin, combined);
    expect(muxedMp4.length).toBeGreaterThan(200);

    const probe = spawnSync("ffprobe", [
      "-hide_banner",
      "-show_entries",
      "stream=codec_type,codec_name",
      "-of",
      "json",
      "pipe:0",
    ], { input: muxedMp4 });
    if (probe.status === 0) {
      const info = JSON.parse(probe.stdout.toString()) as {
        streams: Array<{ codec_type: string; codec_name: string }>;
      };
      expect(info.streams.some((s) => s.codec_type === "video" && s.codec_name === "h264")).toBe(true);
      expect(info.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac")).toBe(true);
    }
  });

  test("new camera settings, reboot, alarm, presets, and save-recording routes require auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapo-routes-auth-"));
    const running = startTapoServer({
      hostname: "127.0.0.1",
      port: 0,
      dataDir: dir,
      directDataDir: true,
    });

    try {
      const checks = await Promise.all([
        fetch(`${running.url}/api/cameras/cam1/settings`),
        fetch(`${running.url}/api/cameras/cam1/settings`, { method: "PATCH", body: "{}" }),
        fetch(`${running.url}/api/cameras/cam1/reboot`, { method: "POST" }),
        fetch(`${running.url}/api/cameras/cam1/alarm/manual`, { method: "POST", body: "{}" }),
        fetch(`${running.url}/api/cameras/cam1/ptz/calibrate`, { method: "POST" }),
        fetch(`${running.url}/api/cameras/cam1/ptz/presets`, { method: "POST", body: "{}" }),
        fetch(`${running.url}/api/cameras/cam1/recordings/save`, { method: "POST", body: "{}" }),
      ]);
      for (const res of checks) {
        expect(res.status).toBe(401);
      }
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("streamSdRecordingMp4 acknowledges X-Data-Sequence, streams fMP4 before EOF, and propagates camera errors", async () => {
    const bin = findFfmpegBinary();
    if (!bin) return;
    const { spawnSync } = await import("node:child_process");

    const vid = spawnSync(bin, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=3:size=320x240:rate=15",
      "-c:v",
      "libx264",
      "-g",
      "15",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mpegts",
      "pipe:1",
    ]);
    expect(vid.status).toBe(0);
    const tsBytes = Buffer.from(vid.stdout);

    const makeMockClient = (onControl: (jsonText: string, sock: EventEmitter) => void, onAck?: (raw: string) => void) => {
      return {
        getPlaybackUserId: async () => 29,
        requestRelay: async () => ({
          host: "127.0.0.1",
          port: 443,
          path: "/relay",
          relayToken: "tok",
          playerId: "p1",
        }),
        openRelayTls: (_target: unknown, _model: string, extra?: { initialControlJson?: string }) => {
          class MockTls extends EventEmitter {
            destroyed = false;
            write(data: Buffer | string) {
              const str = typeof data === "string" ? data : data.toString("latin1");
              onAck?.(str);
              return true;
            }
            end() {
              if (!this.destroyed) {
                this.destroyed = true;
                this.emit("close");
              }
              return this;
            }
            destroy() {
              if (!this.destroyed) {
                this.destroyed = true;
                this.emit("close");
              }
              return this;
            }
          }
          const sock = new MockTls();
          queueMicrotask(() => onControl(extra?.initialControlJson ?? "", sock));
          return sock as unknown as tls.TLSSocket;
        },
      } as unknown as TapoCloudClient;
    };

    const device: CameraMeta = {
      deviceId: "cam-sd-1",
      alias: "Cam 1",
      deviceName: "Tapo C200",
      deviceModel: "C200",
      deviceType: "SMART.IPCAMERA",
      deviceHwVer: "1.0",
      fwVer: "1.0.0",
      deviceRegion: "eu",
      mac: "AA:BB:CC:DD:EE:FF",
      accessPlatform: "tplink",
      appServerUrl: "https://eu-wap.tplinkcloud.com",
      rawStatus: 1,
    };

    const wrapPart = (headers: string, body: Buffer): Buffer =>
      Buffer.concat([
        Buffer.from(`----device-stream-boundary--\r\n${headers}\r\nContent-Length: ${body.length}\r\n\r\n`, "ascii"),
        body,
        Buffer.from("\r\n", "ascii"),
      ]);

    // 1. Streaming + X-Data-Received ACK gate test
    let sentControl: Record<string, unknown> | null = null;
    let ackReceived = false;
    let ackHeaderText = "";
    let sockRef: EventEmitter | null = null;
    let pausedResolve: (() => void) | null = null;
    const ackGate = new Promise<void>((resolve) => {
      pausedResolve = resolve;
    });

    const streamClient = makeMockClient(
      (jsonText, sock) => {
        sockRef = sock;
        sentControl = JSON.parse(jsonText) as Record<string, unknown>;
        sock.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "ascii"));
        const okResp = Buffer.from(
          JSON.stringify({ type: "response", seq: 1, result: { error_code: 0, session_id: "pb-sess-1" } }),
          "utf8",
        );
        sock.emit("data", wrapPart("Content-Type: application/json\r\nX-Session-Id: pb-sess-1", okResp));

        const chunkCount = 26;
        const firstHalf = Math.floor(tsBytes.length * 0.7);
        for (let i = 1; i <= 21; i++) {
          const s = Math.floor((firstHalf * (i - 1)) / 21);
          const e = Math.floor((firstHalf * i) / 21);
          const slice = tsBytes.subarray(s, e);
          if (slice.length > 0) {
            sock.emit("data", wrapPart(`Content-Type: video/mp2t\r\nX-Data-Sequence: ${i}`, slice));
          }
        }

        void ackGate.then(() => {
          for (let i = 22; i <= chunkCount; i++) {
            const rem = tsBytes.length - firstHalf;
            const s = firstHalf + Math.floor((rem * (i - 22)) / (chunkCount - 21));
            const e = firstHalf + Math.floor((rem * (i - 21)) / (chunkCount - 21));
            const slice = tsBytes.subarray(s, e);
            if (slice.length > 0) {
              sock.emit("data", wrapPart(`Content-Type: video/mp2t\r\nX-Data-Sequence: ${i}`, slice));
            }
          }
          const fin = Buffer.from(
            JSON.stringify({ type: "notification", params: { event_type: "playback_finish" } }),
            "utf8",
          );
          sock.emit("data", wrapPart("Content-Type: application/json", fin));
        });
      },
      (raw) => {
        if (raw.includes("X-Data-Received:") && raw.includes("stream_sequence")) {
          ackReceived = true;
          ackHeaderText = raw;
          pausedResolve?.();
        }
      },
    );

    const response = await streamSdRecordingMp4({
      client: streamClient,
      baseUrl: "https://cloud.example",
      token: "t",
      terminalUuid: "u",
      device,
      start: 1700000000,
      end: 1700000010,
      download: false,
      ffmpegPath: bin,
      probeMs: 120,
      startupTimeoutMs: 5000,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("none");
    expect((sentControl as { params?: { playback?: { channels?: number[] } } } | null)?.params?.playback?.channels).toEqual([0]);
    expect(ackReceived).toBe(true);
    expect(ackHeaderText).toContain("X-Session-Id: pb-sess-1");

    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.includes(Buffer.from("ftyp"))).toBe(true);
    expect(buf.includes(Buffer.from("moov"))).toBe(true);
    expect(buf.includes(Buffer.from("moof"))).toBe(true);
    expect(sockRef).not.toBeNull();

    // 2. Rejects immediately when camera responds with result.error_code !== 0
    const errClient = makeMockClient((_jsonText, sock) => {
      sock.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "ascii"));
      const errResp = Buffer.from(
        JSON.stringify({ type: "response", seq: 1, result: { error_code: -71103 } }),
        "utf8",
      );
      sock.emit("data", wrapPart("Content-Type: application/json", errResp));
    });

    await expect(
      streamSdRecordingMp4({
        client: errClient,
        baseUrl: "https://cloud.example",
        token: "t",
        terminalUuid: "u",
        device,
        start: 1700000000,
        end: 1700000010,
        download: false,
        ffmpegPath: bin,
        startupTimeoutMs: 5000,
      }),
    ).rejects.toThrow("-71103");
  });

  test("ffmpeg installer downloads, gunzips, verifies, and resolves binary from app bin directory", async () => {
    expect(getFfmpegAssetName("darwin", "arm64")).toBe("ffmpeg-darwin-arm64.gz");
    expect(getFfmpegAssetName("darwin", "x64")).toBe("ffmpeg-darwin-x64.gz");
    expect(getFfmpegAssetName("win32", "x64")).toBe("ffmpeg-win32-x64.gz");
    expect(getFfmpegAssetName("linux", "x64")).toBe("ffmpeg-linux-x64.gz");
    expect(getFfmpegAssetName("linux", "arm64")).toBe("ffmpeg-linux-arm64.gz");
    expect(getFfmpegAssetName("freebsd", "mips")).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "tapo-ffmpeg-inst-"));
    try {
      const binDir = join(dir, "bin");
      const fakeBinContent = Buffer.from("#!/bin/sh\necho ffmpeg version 6.1.1\n", "utf8");
      const gzPayload = gzipSync(fakeBinContent);

      let requestedUrl = "";
      let currentPath: string | null = null;
      const installer = createFfmpegInstaller({
        installDir: binDir,
        platform: "darwin",
        arch: "arm64",
        resolveExisting: () => currentPath,
        verifyBinary: (p) => readFileSync(p).equals(fakeBinContent),
        fetchImpl: (async (url: string | URL | Request) => {
          requestedUrl = String(url);
          return new Response(new Uint8Array(gzPayload), {
            status: 200,
            headers: { "Content-Length": String(gzPayload.length) },
          });
        }) as unknown as typeof fetch,
        onInstalled: (p) => {
          currentPath = p;
        },
      });

      expect(installer.getState()).toMatchObject({
        phase: "idle",
        available: false,
        supported: true,
      });

      const [res1, res2] = await Promise.all([installer.install(), installer.install()]);
      expect(requestedUrl).toEndWith("/ffmpeg-darwin-arm64.gz");
      expect(res1.phase).toBe("ready");
      expect(res1.available).toBe(true);
      expect(res2.binaryPath).toBe(res1.binaryPath);
      expect(res1.binaryPath).toBe(join(binDir, "ffmpeg"));
      expect(findFfmpegBinary(undefined, [binDir])).toBe(join(binDir, "ffmpeg"));

      // Failed download cleans up temp files and reports error state
      const badDir = join(dir, "bad-bin");
      await expect(
        downloadAndInstallFfmpeg({
          installDir: badDir,
          platform: "linux",
          arch: "x64",
          fetchImpl: (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
        }),
      ).rejects.toThrow("502");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists per-camera 180° orientation & PTZ inversion across workspace and server API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapo-orient-"));
    const running = startTapoServer({
      hostname: "127.0.0.1",
      port: 0,
      dataDir: dir,
      directDataDir: true,
    });

    try {
      const storage = new AppStorage(dir, { directDataDir: true });
      const ws = storage.loadWorkspace();
      expect(ws.cameraOrientations).toEqual({});

      const patchRes = await fetch(`${running.url}/api/cameras/cam-upside`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customName: "Ceiling Cam",
          orientation: { rotate180: true, invertPtz: true },
        }),
      });
      expect(patchRes.status).toBe(200);

      const reloaded = storage.loadWorkspace();
      expect(reloaded.cameraOrientations["cam-upside"]).toEqual({
        rotate180: true,
        invertPtz: true,
      });

      // Emulator merge preserves orientation metadata cleanly
      let simState = addEmulatedCamera(EMPTY_EMULATED_STATE, { name: "Sim Cam" }, "ru").nextState;
      const simId = simState.cameras[0]!.deviceId;
      simState = updateEmulatedCamera(simState, simId, {
        orientation: { rotate180: true, invertPtz: true },
      });
      const merged = mergeDashboardWithEmulator([], [], {}, simState, "ru");
      expect(merged.cameras[0]?.orientation).toEqual({ rotate180: true, invertPtz: true });

      // /api/system/ffmpeg endpoint returns install status
      const ffmpegRes = await fetch(`${running.url}/api/system/ffmpeg`);
      expect(ffmpegRes.status).toBe(200);
      const ffmpegJson = (await ffmpegRes.json()) as { supported?: boolean; phase?: string };
      expect(typeof ffmpegJson.supported).toBe("boolean");
      expect(typeof ffmpegJson.phase).toBe("string");
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("streamSdRecordingMp4 keeps live running normally, re-indexes empty stream_status=finished, and only suspends live on -52405 fallback", async () => {
    const bin = findFfmpegBinary();
    if (!bin) return;
    const { spawnSync } = await import("node:child_process");

    const vid = spawnSync(bin, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=320x240:rate=15",
      "-c:v",
      "libx264",
      "-g",
      "15",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mpegts",
      "pipe:1",
    ]);
    expect(vid.status).toBe(0);
    const tsBytes = Buffer.from(vid.stdout);

    const device: CameraMeta = {
      deviceId: "cam-busy-1",
      alias: "Busy Cam",
      deviceName: "Tapo C200",
      deviceModel: "C200",
      deviceType: "SMART.IPCAMERA",
      deviceHwVer: "1.0",
      fwVer: "1.0.0",
      deviceRegion: "eu",
      mac: "AA:BB:CC:DD:EE:02",
      accessPlatform: "tplink",
      appServerUrl: "https://eu-wap.tplinkcloud.com",
      rawStatus: 1,
    };

    const wrapPart = (headers: string, body: Buffer): Buffer =>
      Buffer.concat([
        Buffer.from(`----device-stream-boundary--\r\n${headers}\r\nContent-Length: ${body.length}\r\n\r\n`, "ascii"),
        body,
        Buffer.from("\r\n", "ascii"),
      ]);

    const events: string[] = [];
    let liveSocketDestroyed = false;
    let playbackAttempt = 0;
    let prepareCalls = 0;
    let invalidateCalls = 0;
    let mode: "empty_then_ok" | "busy_then_ok" = "empty_then_ok";

    const mockClient = {
      preparePlaybackSession: async (
        _baseUrl: string,
        _token: string,
        _tu: string,
        _did: string,
        _s: number,
        _e: number,
        opts?: { forceRefresh?: boolean },
      ) => {
        prepareCalls += 1;
        events.push(`prepare:${opts?.forceRefresh ? "refresh" : "initial"}`);
        return { clientId: 7 + prepareCalls, fromCache: !opts?.forceRefresh };
      },
      invalidatePlaybackSession: () => {
        invalidateCalls += 1;
        events.push("invalidate");
      },
      getPlaybackUserId: async () => 7,
      requestRelay: async (_baseUrl: string, _token: string, _dev: CameraMeta, opts: { streamType: number }) => {
        events.push(`requestRelay:${opts.streamType}`);
        return {
          host: "127.0.0.1",
          port: 443,
          path: "/relay",
          relayToken: "tok",
          playerId: `p-${opts.streamType}`,
        };
      },
      openRelayTls: (_target: unknown, _model: string, extra?: { trackId?: string }) => {
        class MockTls extends EventEmitter {
          destroyed = false;
          write() {
            return true;
          }
          end() {
            if (!this.destroyed) {
              this.destroyed = true;
              this.emit("close");
            }
            return this;
          }
          destroy() {
            if (!this.destroyed) {
              this.destroyed = true;
              if (!extra?.trackId) liveSocketDestroyed = true;
              events.push(extra?.trackId ? "destroy:playback" : "destroy:live");
              this.emit("close");
            }
            return this;
          }
        }
        const sock = new MockTls();
        if (!extra?.trackId) {
          events.push("open:live");
          return sock as unknown as tls.TLSSocket;
        }
        playbackAttempt += 1;
        const thisAttempt = playbackAttempt;
        events.push(`open:playback:${thisAttempt}`);
        queueMicrotask(() => {
          sock.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "ascii"));
          if (mode === "empty_then_ok" && thisAttempt === 1) {
            const okResp = Buffer.from(
              JSON.stringify({ type: "response", seq: 1, params: { error_code: 0, session_id: "pb-empty" } }),
              "utf8",
            );
            sock.emit("data", wrapPart("Content-Type: application/json", okResp));
            const fin = Buffer.from(
              JSON.stringify({ type: "notification", params: { event_type: "stream_status", status: "finished" } }),
              "utf8",
            );
            sock.emit("data", wrapPart("Content-Type: application/json", fin));
            return;
          }
          if (mode === "busy_then_ok" && thisAttempt === 1) {
            const busyResp = Buffer.from(
              JSON.stringify({ type: "response", seq: 1, result: { error_code: -52405 } }),
              "utf8",
            );
            sock.emit("data", wrapPart("Content-Type: application/json", busyResp));
            return;
          }
          const okResp = Buffer.from(
            JSON.stringify({ type: "response", seq: 2, result: { error_code: 0, session_id: "pb-ok" } }),
            "utf8",
          );
          sock.emit("data", wrapPart("Content-Type: application/json\r\nX-Session-Id: pb-ok", okResp));
          sock.emit("data", wrapPart("Content-Type: video/mp2t\r\nX-Data-Sequence: 1", tsBytes));
          const fin = Buffer.from(
            JSON.stringify({ type: "notification", params: { event_type: "stream_status", status: "finished" } }),
            "utf8",
          );
          sock.emit("data", wrapPart("Content-Type: application/json", fin));
        });
        return sock as unknown as tls.TLSSocket;
      },
    } as unknown as TapoCloudClient;

    const streams = new StreamManager(
      mockClient,
      () => ({ baseUrl: "https://cloud.example", token: "tok" }),
      () => ({
        gridFps: 10,
        gridResolution: "VGA",
        gridTransport: "webcodecs",
        autoCycleSeconds: 0,
        language: "ru",
      }),
      async () => false,
      { ffmpegPath: bin, getLang: () => "ru" },
    );
    streams.syncCameras([device]);
    const unsubLive = streams.subscribeTs(device.deviceId, "hd", () => {});

    try {
      await Bun.sleep(40);
      expect(events).toContain("open:live");

      // Case 1: Empty stream_status=finished triggers re-index retry WITHOUT killing live stream
      const res1 = await streamSdRecordingMp4({
        client: mockClient,
        baseUrl: "https://cloud.example",
        token: "tok",
        terminalUuid: "u",
        device,
        start: 1700000100,
        end: 1700000110,
        download: false,
        ffmpegPath: bin,
        probeMs: 120,
        startupTimeoutMs: 5000,
        acquirePlaybackSlot: (abortFn) => streams.acquirePlaybackSlot(device.deviceId, abortFn),
        suspendLiveStream: () => streams.suspendLiveWorker(device.deviceId),
      });
      expect(liveSocketDestroyed).toBe(false);
      expect(invalidateCalls).toBe(1);
      expect(events).toContain("prepare:refresh");
      const mp4First = Buffer.from(await res1.arrayBuffer());
      expect(mp4First.includes(Buffer.from("ftyp"))).toBe(true);

      // Case 2: -52405 busy triggers live suspend fallback and auto-resumes afterward
      mode = "busy_then_ok";
      playbackAttempt = 0;
      const res2 = await streamSdRecordingMp4({
        client: mockClient,
        baseUrl: "https://cloud.example",
        token: "tok",
        terminalUuid: "u",
        device,
        start: 1700000200,
        end: 1700000210,
        download: false,
        ffmpegPath: bin,
        probeMs: 120,
        startupTimeoutMs: 5000,
        acquirePlaybackSlot: (abortFn) => streams.acquirePlaybackSlot(device.deviceId, abortFn),
        suspendLiveStream: () => streams.suspendLiveWorker(device.deviceId),
      });

      expect(liveSocketDestroyed).toBe(true);
      expect(playbackAttempt).toBe(2);
      expect(res2.status).toBe(200);

      const mp4Second = Buffer.from(await res2.arrayBuffer());
      expect(mp4Second.includes(Buffer.from("ftyp"))).toBe(true);

      await Bun.sleep(40);
      const liveOpens = events.filter((e) => e === "open:live").length;
      expect(liveOpens).toBeGreaterThanOrEqual(2);
    } finally {
      unsubLive();
      streams.stopAll();
    }
  });

  test("resolveTimelineDropTarget plays inside clip and auto-skips grey gaps to next clip", () => {
    const clips = [
      {
        start: 1000,
        end: 1120,
        duration: 120,
        type: 1,
        startLocal: "2026-11-26 10:00:00",
        endLocal: "2026-11-26 10:02:00",
        source: "segment" as const,
        eventKinds: ["continuous" as const],
      },
      {
        start: 1040,
        end: 1070,
        duration: 30,
        type: 6,
        startLocal: "2026-11-26 10:00:40",
        endLocal: "2026-11-26 10:01:10",
        source: "event" as const,
        eventKinds: ["person" as const, "motion" as const],
      },
      {
        start: 2000,
        end: 2060,
        duration: 60,
        type: 2,
        startLocal: "2026-11-26 10:16:40",
        endLocal: "2026-11-26 10:17:40",
        source: "event" as const,
        eventKinds: ["motion" as const],
      },
    ];

    // Inside overlapping continuous + person -> prefers person event & seeks to exact second
    const hitPerson = resolveTimelineDropTarget(1055, clips);
    expect(hitPerson?.skippedGap).toBe(false);
    expect(hitPerson?.clip.start).toBe(1040);
    expect(hitPerson?.seekStartSec).toBe(1055);

    // Clicking inside first 3s of clip snaps cleanly to clip.start
    const hitStart = resolveTimelineDropTarget(2002, clips);
    expect(hitStart?.skippedGap).toBe(false);
    expect(hitStart?.seekStartSec).toBe(2000);

    // Dropping in grey gap between 1120 and 2000 -> auto-skips forward to clip starting at 2000
    const hitGap = resolveTimelineDropTarget(1500, clips);
    expect(hitGap?.skippedGap).toBe(true);
    expect(hitGap?.clip.start).toBe(2000);
    expect(hitGap?.seekStartSec).toBe(2000);

    // Dropping past the last clip -> snaps to last clip
    const hitAfter = resolveTimelineDropTarget(5000, clips);
    expect(hitAfter?.skippedGap).toBe(true);
    expect(hitAfter?.clip.start).toBe(2000);
  });

  test("mergeDashboardWithEmulator mirrors real camera stream and orientation by default, and supports synthetic mode", async () => {
    const { setEmulatedVideoSource } = await import("../src/client/lib/debug-emulator");
    const realCam: CameraMeta = {
      deviceId: "real-c200-1",
      alias: "Hall C200",
      orientation: { rotate180: true, invertPtz: true },
      deviceModel: "C200",
      deviceName: "Tapo C200",
      deviceHwVer: "5.0",
      fwVer: "1.5.7",
      deviceRegion: "eu",
      accessPlatform: "IOT",
      appServerUrl: "https://eu.example",
      deviceType: "SMART.IPCAMERA",
      rawStatus: 1,
    };

    let sim = addEmulatedCamera(EMPTY_EMULATED_STATE, { name: "Clone 1" }, "ru").nextState;
    const mergedAuto = mergeDashboardWithEmulator([realCam], [], {}, sim, "ru");
    const simMetaAuto = mergedAuto.cameras.find((c) => c.deviceId !== realCam.deviceId);
    expect(simMetaAuto?.mirrorSourceDeviceId).toBe("real-c200-1");
    expect(simMetaAuto?.orientation).toEqual({ rotate180: true, invertPtz: true });

    sim = setEmulatedVideoSource(sim, "synthetic");
    const mergedSynth = mergeDashboardWithEmulator([realCam], [], {}, sim, "ru");
    const simMetaSynth = mergedSynth.cameras.find((c) => c.deviceId !== realCam.deviceId);
    expect(simMetaSynth?.mirrorSourceDeviceId).toBeUndefined();
  });
});
