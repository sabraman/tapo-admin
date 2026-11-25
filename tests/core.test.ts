import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTapoServer } from "../src/server/app";
import { buildAccessCookie, createAccessGuard } from "../src/server/auth-guard";
import { findFfmpegBinary, resolveRuntimeServerConfig } from "../src/server/config";
import { MulawTsExtractor } from "../src/server/mulaw-extractor";
import { AppStorage } from "../src/server/storage";
import { attachSocketInactivityTimeout, createRelayPartDemuxer, TapoTalkEncoder } from "../src/server/tapo-cloud";
import { TsGopBuffer } from "../src/server/ts-gop-buffer";
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
} from "../src/client/lib/debug-emulator";
import {
  normalizeLanguagePreference,
  resolveLanguage,
  SERVER_MESSAGES,
  tServer,
} from "../src/shared/i18n";
import type { CameraMeta, CameraTelemetry, DashboardBootstrap } from "../src/shared/types";

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
      expect(statSync(storage.sessionPath).mode & 0o777).toBe(0o600);

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
