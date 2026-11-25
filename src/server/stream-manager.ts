import type tls from "node:tls";
import { type ServerMessageKey, tServer } from "../shared/i18n";
import type {
  CameraMeta,
  CameraTelemetry,
  DashboardSettings,
  RelayEventLog,
  RelayStatus,
  ResolvedLanguage,
  StreamMode,
  StreamQuality,
} from "../shared/types";
import { findFfmpegBinary } from "./config";
import { MulawTsExtractor } from "./mulaw-extractor";
import {
  createRelayPartDemuxer,
  TapoCloudClient,
  TapoCloudError,
  TapoTalkEncoder,
  writeRelayAudioFrame,
} from "./tapo-cloud";
import { TsGopBuffer } from "./ts-gop-buffer";

export type MjpegListener = (jpeg: Buffer) => void;
export type Fmp4Listener = (kind: "init" | "frag" | "reset", payload: Buffer, mime?: string) => void;
export type TsListener = (kind: "chunk" | "reset", payload: Buffer) => void;
export type AudioListener = (mp3Chunk: Buffer) => void;
export type RawAudioListener = (mulawChunk: Buffer) => void;

function extractAvcCodecMime(moov: Buffer): string {
  const idx = moov.indexOf(Buffer.from("avcC"));
  if (idx !== -1 && idx + 8 < moov.length) {
    const profile = moov[idx + 5]!;
    const compat = moov[idx + 6]!;
    const level = moov[idx + 7]!;
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return `video/mp4; codecs="avc1.${hex(profile)}${hex(compat)}${hex(level)}"`;
  }
  return 'video/mp4; codecs="avc1.640028"';
}

class CameraWorker {
  private mjpegListeners = new Set<MjpegListener>();
  private fmp4Listeners = new Set<Fmp4Listener>();
  private tsGridListeners = new Set<TsListener>();
  private tsHdListeners = new Set<TsListener>();
  private audioListeners = new Set<AudioListener>();
  private rawAudioListeners = new Set<RawAudioListener>();
  private tsGop = new TsGopBuffer();

  private activeSocket: tls.TLSSocket | null = null;
  private mjpegProc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private fmp4Proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private audioProc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private abortCurrentRelay: (() => void) | null = null;

  private initSegment: Buffer | null = null;
  private initMime = 'video/mp4; codecs="avc1.640028"';
  private latestJpeg: Buffer | null = null;
  private latestJpegAt = 0;

  private tsRing: Buffer[] = [];
  private tsRingBytes = 0;
  private readonly maxRingBytes = 4 * 1024 * 1024;

  private status: RelayStatus = "idle";
  private currentResolution: StreamQuality = "VGA";
  private bytesTotal = 0;
  private bytesWindow = 0;
  private kbps = 0;
  private lastKbpsSampleAt = Date.now();
  private connectLatencyMs: number | null = null;
  private lastFrameAt: number | null = null;
  private reconnects = 0;
  private lastError: string | null = null;

  constructor(
    private device: CameraMeta,
    private getCreds: () => { baseUrl: string; token: string } | null,
    private getSettings: () => DashboardSettings,
    private getFfmpegPath: () => string | null,
    private getLang: () => ResolvedLanguage,
    private client: TapoCloudClient,
    private onUpdate: () => void,
    private onLog: (
      level: RelayEventLog["level"],
      message: string,
      deviceId?: string,
      messageKey?: ServerMessageKey | string,
      messageParams?: Record<string, string | number>,
    ) => void,
    private onAuthExpired: () => Promise<boolean>,
  ) {}

  private pushKeyedLog(
    level: RelayEventLog["level"],
    key: ServerMessageKey,
    params?: Record<string, string | number>,
  ): void {
    this.onLog(level, tServer(this.getLang(), key, params), this.device.deviceId, key, params);
  }

  updateMeta(device: CameraMeta): void {
    this.device = device;
  }

  getDevice(): CameraMeta {
    return this.device;
  }

  getTelemetry(): CameraTelemetry {
    const mode: StreamMode =
      this.fmp4Listeners.size > 0 || this.tsHdListeners.size > 0
        ? "focus_hd"
        : this.mjpegListeners.size > 0 || this.tsGridListeners.size > 0
          ? "grid_low"
          : "off";
    return {
      deviceId: this.device.deviceId,
      status: this.status,
      mode,
      resolution: this.currentResolution,
      gridFps: this.getSettings().gridFps,
      subscribers:
        this.mjpegListeners.size +
        this.fmp4Listeners.size +
        this.tsGridListeners.size +
        this.tsHdListeners.size,
      audioSubscribers: this.audioListeners.size + this.rawAudioListeners.size,
      kbps: this.kbps,
      bytesTotal: this.bytesTotal,
      connectLatencyMs: this.connectLatencyMs,
      lastFrameAt: this.lastFrameAt,
      reconnects: this.reconnects,
      lastError: this.lastError,
    };
  }

  getLatestJpeg(): { jpeg: Buffer; ts: number } | null {
    if (!this.latestJpeg) return null;
    return { jpeg: this.latestJpeg, ts: this.latestJpegAt };
  }

  getRollingTsBuffer(): Buffer {
    return Buffer.concat(this.tsRing);
  }

  addMjpegListener(fn: MjpegListener): () => void {
    if (this.latestJpeg) fn(this.latestJpeg);
    this.mjpegListeners.add(fn);
    this.ensureRunning();
    return () => {
      this.mjpegListeners.delete(fn);
      this.scheduleIdleStop();
      this.onUpdate();
    };
  }

  addFmp4Listener(fn: Fmp4Listener): () => void {
    const needsUpgrade = this.fmp4Listeners.size === 0 && this.tsHdListeners.size === 0;
    this.fmp4Listeners.add(fn);
    if (this.initSegment && (!this.running || this.currentResolution === "HD")) {
      fn("init", this.initSegment, this.initMime);
    }
    this.ensureRunning();
    if (needsUpgrade && this.running && this.currentResolution !== "HD") {
      this.interruptRelay();
    }
    return () => {
      this.fmp4Listeners.delete(fn);
      this.reconcileResolutionOrStop();
      this.onUpdate();
    };
  }

  addTsListener(quality: "grid" | "hd", fn: TsListener): () => void {
    const set = quality === "hd" ? this.tsHdListeners : this.tsGridListeners;
    const needsUpgrade = quality === "hd" && this.running && this.currentResolution !== "HD";
    set.add(fn);
    if (!needsUpgrade) {
      const boot = this.tsGop.getBootstrapChunk();
      if (boot) fn("chunk", boot);
    }
    this.ensureRunning();
    if (needsUpgrade) {
      this.interruptRelay();
    }
    return () => {
      set.delete(fn);
      this.reconcileResolutionOrStop();
      this.onUpdate();
    };
  }

  private reconcileResolutionOrStop(): void {
    if (!this.hasAnyListeners()) {
      this.scheduleIdleStop();
      return;
    }
    if (
      this.running &&
      this.currentResolution === "HD" &&
      this.desiredResolution() !== "HD"
    ) {
      this.interruptRelay();
    }
  }

  addAudioListener(fn: AudioListener): () => void {
    const first = this.audioListeners.size === 0;
    this.audioListeners.add(fn);
    this.ensureRunning();
    if (first && this.running && !this.audioProc) {
      this.startAudioEncoder();
    }
    return () => {
      this.audioListeners.delete(fn);
      if (this.audioListeners.size === 0) {
        this.stopProc(this.audioProc);
        this.audioProc = null;
      }
      this.scheduleIdleStop();
      this.onUpdate();
    };
  }

  onGridSettingsChanged(): void {
    if (this.mjpegListeners.size > 0 && this.running) {
      this.stopProc(this.mjpegProc);
      this.mjpegProc = null;
      this.startMjpegDecoder();
    }
    if (this.running && this.desiredResolution() !== this.currentResolution) {
      this.interruptRelay();
    }
    this.onUpdate();
  }

  stopImmediate(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.running = false;
    this.interruptRelay();
    this.killAllProcs();
    this.status = "idle";
    this.kbps = 0;
    this.onUpdate();
  }

  addRawAudioListener(fn: RawAudioListener): () => void {
    this.rawAudioListeners.add(fn);
    this.ensureRunning();
    return () => {
      this.rawAudioListeners.delete(fn);
      this.scheduleIdleStop();
      this.onUpdate();
    };
  }

  private hasAnyListeners(): boolean {
    return (
      this.mjpegListeners.size > 0 ||
      this.fmp4Listeners.size > 0 ||
      this.tsGridListeners.size > 0 ||
      this.tsHdListeners.size > 0 ||
      this.audioListeners.size > 0 ||
      this.rawAudioListeners.size > 0
    );
  }

  private ensureRunning(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.running = true;
    if (!this.loopPromise) {
      this.loopPromise = this.runLoop().finally(() => {
        this.loopPromise = null;
        this.running = false;
        this.killAllProcs();
        this.status = "idle";
        this.kbps = 0;
        this.onUpdate();
        // If a listener arrived while the previous loop was tearing down, start cleanly.
        if (this.hasAnyListeners()) {
          queueMicrotask(() => {
            if (this.hasAnyListeners()) this.ensureRunning();
          });
        }
      });
    }
    this.onUpdate();
  }

  private scheduleIdleStop(): void {
    if (this.hasAnyListeners()) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.hasAnyListeners()) {
        this.running = false;
        this.interruptRelay();
      }
    }, 4000);
  }

  private interruptRelay(): void {
    this.abortCurrentRelay?.();
    try {
      this.activeSocket?.destroy();
    } catch {
      // socket already torn down
    }
    this.activeSocket = null;
  }

  private desiredResolution(): StreamQuality {
    if (this.fmp4Listeners.size > 0 || this.tsHdListeners.size > 0) return "HD";
    return this.getSettings().gridResolution;
  }

  private async runLoop(): Promise<void> {
    let firstAttempt = true;
    while (this.running && this.hasAnyListeners()) {
      const creds = this.getCreds();
      if (!creds) {
        this.status = "error";
        this.lastError = tServer(this.getLang(), "login_required_for_stream");
        this.onUpdate();
        break;
      }

      if (!firstAttempt) {
        this.reconnects += 1;
        this.status = "reconnecting";
        this.onUpdate();
      } else {
        this.status = "connecting";
        this.onUpdate();
      }
      firstAttempt = false;

      try {
        await this.runSingleRelay(creds.baseUrl, creds.token);
        this.lastError = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        if (err instanceof TapoCloudError && err.isAuthError) {
          this.pushKeyedLog("warn", "stream_token_refresh", { alias: this.device.alias });
          const refreshed = await this.onAuthExpired();
          if (refreshed) continue;
        }
        if (err instanceof TapoCloudError && (err.code === -40401 || err.code === -40406)) {
          this.status = "offline";
        } else if (msg.includes("x-if-encrypt")) {
          this.status = "encrypted";
        } else {
          this.status = "error";
        }
        this.kbps = 0;
        this.onLog("error", `${this.device.alias}: ${msg}`, this.device.deviceId);
        this.onUpdate();
        if (!this.running || !this.hasAnyListeners()) break;
        await Bun.sleep(2500);
      }
    }
  }

  private async runSingleRelay(baseUrl: string, token: string): Promise<void> {
    const resolution = this.desiredResolution();
    this.currentResolution = resolution;
    const tStart = Date.now();
    this.pushKeyedLog("info", "stream_connecting", {
      alias: this.device.alias,
      resolution,
    });

    const target = await this.client.requestRelay(baseUrl, token, this.device, {
      resolution,
      streamType: 0,
    });

    if (!this.running || !this.hasAnyListeners() || this.desiredResolution() !== resolution) return;

    this.tsGop.reset();
    const extractor = new MulawTsExtractor();
    if (this.mjpegListeners.size > 0 && !this.mjpegProc) this.startMjpegDecoder();
    if (this.fmp4Listeners.size > 0 && !this.fmp4Proc) this.startFmp4Muxer();
    if (this.audioListeners.size > 0 && !this.audioProc) this.startAudioEncoder();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.abortCurrentRelay = null;
        if (this.activeSocket === sock) this.activeSocket = null;
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        if (this.fmp4Listeners.size > 0) {
          this.initSegment = null;
          for (const fn of this.fmp4Listeners) fn("reset", Buffer.alloc(0));
        }
        if (this.tsGridListeners.size > 0 || this.tsHdListeners.size > 0) {
          const empty = Buffer.alloc(0);
          for (const fn of this.tsGridListeners) fn("reset", empty);
          for (const fn of this.tsHdListeners) fn("reset", empty);
        }
        this.tsGop.reset();
        this.stopProc(this.fmp4Proc);
        this.fmp4Proc = null;
        this.stopProc(this.mjpegProc);
        this.mjpegProc = null;
        if (err) reject(err);
        else resolve();
      };

      const sock = this.client.openRelayTls(target, this.device.deviceModel);
      this.activeSocket = sock;
      this.abortCurrentRelay = () => done();

      let gotFirstChunk = false;
      const demux = createRelayPartDemuxer((_hdrs, payload) => {
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          this.connectLatencyMs = Date.now() - tStart;
          this.status = "streaming";
          this.lastError = null;
          this.pushKeyedLog("info", "stream_started", {
            alias: this.device.alias,
            resolution,
            ms: this.connectLatencyMs,
          });
          this.onUpdate();
        }

        this.bytesTotal += payload.length;
        this.bytesWindow += payload.length;
        const now = Date.now();
        this.lastFrameAt = now;
        const elapsedMs = now - this.lastKbpsSampleAt;
        if (elapsedMs >= 1000) {
          this.kbps = Math.round((this.bytesWindow * 8) / elapsedMs);
          this.bytesWindow = 0;
          this.lastKbpsSampleAt = now;
          this.onUpdate();
        }

        this.pushRollingTs(payload);
        const alignedTs = this.tsGop.feed(payload);

        if (alignedTs.length > 0 && (this.tsGridListeners.size > 0 || this.tsHdListeners.size > 0)) {
          for (const fn of this.tsGridListeners) fn("chunk", alignedTs);
          for (const fn of this.tsHdListeners) fn("chunk", alignedTs);
        }

        if (this.mjpegListeners.size > 0 && !this.mjpegProc) this.startMjpegDecoder();
        if (this.fmp4Listeners.size > 0 && !this.fmp4Proc) this.startFmp4Muxer();
        if (this.audioListeners.size > 0 && !this.audioProc) this.startAudioEncoder();

        this.writeToProc(this.mjpegProc, payload);
        this.writeToProc(this.fmp4Proc, payload);

        if (this.audioProc || this.rawAudioListeners.size > 0) {
          const mulaw = extractor.feed(payload);
          if (mulaw.length > 0) {
            if (this.audioProc) this.writeToProc(this.audioProc, mulaw);
            for (const fn of this.rawAudioListeners) fn(mulaw);
          }
        }
      }, this.getLang);

      sock.on("data", (chunk: Buffer) => {
        try {
          const res = demux(chunk);
          if (res.encrypted) {
            done(new TapoCloudError(tServer(this.getLang(), "stream_encrypted")));
          }
        } catch (err) {
          done(err instanceof Error ? err : new Error(String(err)));
        }
      });

      sock.on("timeout", () => done(new Error(tServer(this.getLang(), "stream_timeout"))));
      sock.on("error", (err) => done(err));
      sock.on("close", () => {
        if (!this.running || !this.hasAnyListeners()) {
          done();
        } else {
          done(new Error(tServer(this.getLang(), "stream_closed")));
        }
      });
    });
  }

  private pushRollingTs(chunk: Buffer): void {
    this.tsRing.push(Buffer.from(chunk));
    this.tsRingBytes += chunk.length;
    while (this.tsRingBytes > this.maxRingBytes && this.tsRing.length > 1) {
      const removed = this.tsRing.shift()!;
      this.tsRingBytes -= removed.length;
    }
  }

  private writeToProc(proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null, data: Uint8Array): void {
    if (!proc || proc.killed) return;
    try {
      proc.stdin.write(data);
    } catch {
      // decoder exited
    }
  }

  private stopProc(proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null): void {
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  private killAllProcs(): void {
    this.stopProc(this.mjpegProc);
    this.mjpegProc = null;
    this.stopProc(this.fmp4Proc);
    this.fmp4Proc = null;
    this.stopProc(this.audioProc);
    this.audioProc = null;
  }

  private requireFfmpegOrLog(): string | null {
    const bin = this.getFfmpegPath();
    if (bin) return bin;
    const msg = tServer(this.getLang(), "ffmpeg_missing");
    if (this.lastError !== msg) {
      this.lastError = msg;
      this.status = "error";
      this.pushKeyedLog("error", "ffmpeg_missing");
      this.onUpdate();
    }
    return null;
  }

  private startMjpegDecoder(): void {
    const bin = this.requireFfmpegOrLog();
    if (!bin) return;
    const fps = this.getSettings().gridFps;
    // Keyframe-only decode for <= 1 fps grid saves ~90-95% FFmpeg CPU by skipping P-frames.
    const args = [
      bin,
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-analyzeduration",
      "0",
      "-probesize",
      "32768",
      ...(fps <= 1 ? ["-skip_frame", "nokey"] : []),
      "-f",
      "mpegts",
      "-i",
      "pipe:0",
      "-an",
      ...(fps <= 1
        ? ["-fps_mode", "vfr", "-vf", "scale=854:-2"]
        : ["-vf", `fps=${fps},scale=854:-2`]),
      "-q:v",
      "6",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ];
    const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.mjpegProc = proc;
    void this.readJpegStream(proc);
  }

  private async readJpegStream(proc: Bun.Subprocess<"pipe", "pipe", "ignore">): Promise<void> {
    let buf = Buffer.alloc(0);
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.mjpegProc !== proc) break;
        buf = buf.length === 0 ? Buffer.from(value) : Buffer.concat([buf, value]);

        while (true) {
          const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
          if (start === -1) {
            buf = Buffer.alloc(0);
            break;
          }
          const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
          if (end === -1) {
            if (start > 0) buf = buf.subarray(start);
            break;
          }
          const frame = Buffer.from(buf.subarray(start, end + 2));
          buf = buf.subarray(end + 2);
          this.latestJpeg = frame;
          this.latestJpegAt = Date.now();
          for (const fn of this.mjpegListeners) fn(frame);
        }
      }
    } catch {
      // stream terminated
    } finally {
      reader.releaseLock();
    }
  }

  private startFmp4Muxer(): void {
    const bin = this.requireFfmpegOrLog();
    if (!bin) return;
    this.initSegment = null;
    const proc = Bun.spawn(
      [
        bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-analyzeduration",
        "0",
        "-probesize",
        "32768",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-an",
        "-flush_packets",
        "1",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-movflags",
        "+empty_moov+default_base_moof+frag_every_frame",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    this.fmp4Proc = proc;
    void this.readFmp4Stream(proc);
  }

  private async readFmp4Stream(proc: Bun.Subprocess<"pipe", "pipe", "ignore">): Promise<void> {
    let buf = Buffer.alloc(0);
    let ftypBox: Buffer | null = null;
    let pendingMoof: Buffer | null = null;
    const reader = proc.stdout.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.fmp4Proc !== proc) break;
        buf = buf.length === 0 ? Buffer.from(value) : Buffer.concat([buf, value]);

        while (buf.length >= 8) {
          const boxSize = buf.readUInt32BE(0);
          if (boxSize < 8 || buf.length < boxSize) break;
          const boxType = buf.subarray(4, 8).toString("ascii");
          const box = Buffer.from(buf.subarray(0, boxSize));
          buf = buf.subarray(boxSize);

          if (boxType === "ftyp") {
            ftypBox = box;
          } else if (boxType === "moov") {
            const init = ftypBox ? Buffer.concat([ftypBox, box]) : box;
            this.initSegment = init;
            this.initMime = extractAvcCodecMime(box);
            for (const fn of this.fmp4Listeners) fn("init", init, this.initMime);
          } else if (boxType === "moof") {
            pendingMoof = box;
          } else if (boxType === "mdat" && pendingMoof) {
            const frag = Buffer.concat([pendingMoof, box]);
            pendingMoof = null;
            for (const fn of this.fmp4Listeners) fn("frag", frag);
          } else if (this.initSegment) {
            for (const fn of this.fmp4Listeners) fn("frag", box);
          }
        }
      }
    } catch {
      // stream terminated
    } finally {
      reader.releaseLock();
    }
  }

  private startAudioEncoder(): void {
    const bin = this.requireFfmpegOrLog();
    if (!bin) return;
    const proc = Bun.spawn(
      [
        bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "mulaw",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "48k",
        "-flush_packets",
        "1",
        "-f",
        "mp3",
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    this.audioProc = proc;
    void this.readAudioStream(proc);
  }

  private async readAudioStream(proc: Bun.Subprocess<"pipe", "pipe", "ignore">): Promise<void> {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.audioProc !== proc) break;
        const chunk = Buffer.from(value);
        for (const fn of this.audioListeners) fn(chunk);
      }
    } catch {
      // terminated
    } finally {
      reader.releaseLock();
    }
  }
}

export class StreamManager {
  private workers = new Map<string, CameraWorker>();
  private eventListeners = new Set<(ev: { type: "telemetry" | "log"; data: unknown }) => void>();
  private logs: RelayEventLog[] = [];
  private activeCleanups = new Set<() => void>();
  private readonly ffmpegPath: string | null;
  private readonly getLang: () => ResolvedLanguage;

  constructor(
    private client: TapoCloudClient,
    private getCreds: () => { baseUrl: string; token: string } | null,
    private getSettings: () => DashboardSettings,
    private onAuthExpired: () => Promise<boolean>,
    options?: {
      ffmpegPath?: string | null;
      getLang?: () => ResolvedLanguage;
    },
  ) {
    this.ffmpegPath =
      options?.ffmpegPath !== undefined ? options.ffmpegPath : findFfmpegBinary();
    this.getLang = options?.getLang ?? (() => "en");
  }

  registerCleanup(cleanup: () => void): () => void {
    this.activeCleanups.add(cleanup);
    return () => {
      this.activeCleanups.delete(cleanup);
    };
  }

  syncCameras(cameras: CameraMeta[]): void {
    const ids = new Set(cameras.map((c) => c.deviceId));
    for (const [id, w] of this.workers) {
      if (!ids.has(id)) {
        w.stopImmediate();
        this.workers.delete(id);
      }
    }
    for (const cam of cameras) {
      const existing = this.workers.get(cam.deviceId);
      if (existing) {
        existing.updateMeta(cam);
      } else {
        this.workers.set(
          cam.deviceId,
          new CameraWorker(
            cam,
            this.getCreds,
            this.getSettings,
            () => this.ffmpegPath,
            this.getLang,
            this.client,
            () => this.emitTelemetry(),
            (level, msg, devId, messageKey, messageParams) =>
              this.pushLog(level, msg, devId, messageKey, messageParams),
            this.onAuthExpired,
          ),
        );
      }
    }
  }

  getAllTelemetry(): Record<string, CameraTelemetry> {
    const out: Record<string, CameraTelemetry> = {};
    for (const [id, w] of this.workers) {
      out[id] = w.getTelemetry();
    }
    return out;
  }

  getLogs(): RelayEventLog[] {
    return this.logs;
  }

  pushLog(
    level: RelayEventLog["level"],
    message: string,
    deviceId?: string,
    messageKey?: ServerMessageKey | string,
    messageParams?: Record<string, string | number>,
  ): void {
    const entry: RelayEventLog = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      level,
      deviceId,
      message,
      ...(messageKey ? { messageKey } : {}),
      ...(messageParams ? { messageParams } : {}),
    };
    this.logs.unshift(entry);
    if (this.logs.length > 120) this.logs.length = 120;
    for (const fn of this.eventListeners) fn({ type: "log", data: entry });
  }

  pushLocalizedLog(
    level: RelayEventLog["level"],
    messageKey: ServerMessageKey,
    messageParams?: Record<string, string | number>,
    deviceId?: string,
  ): void {
    const message = tServer(this.getLang(), messageKey, messageParams);
    this.pushLog(level, message, deviceId, messageKey, messageParams);
  }

  subscribeEvents(fn: (ev: { type: "telemetry" | "log"; data: unknown }) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private emitTelemetry(): void {
    const data = this.getAllTelemetry();
    for (const fn of this.eventListeners) fn({ type: "telemetry", data });
  }

  notifyGridSettingsChanged(): void {
    for (const w of this.workers.values()) w.onGridSettingsChanged();
  }

  stopAll(): void {
    for (const cleanup of Array.from(this.activeCleanups)) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    this.activeCleanups.clear();
    for (const w of this.workers.values()) w.stopImmediate();
  }

  subscribeMjpeg(deviceId: string, fn: MjpegListener): () => void {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));
    return w.addMjpegListener(fn);
  }

  subscribeFmp4(deviceId: string, fn: Fmp4Listener): () => void {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));
    return w.addFmp4Listener(fn);
  }

  subscribeTs(deviceId: string, quality: "grid" | "hd", fn: TsListener): () => void {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));
    return w.addTsListener(quality, fn);
  }

  subscribeAudio(deviceId: string, fn: AudioListener): () => void {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));
    return w.addAudioListener(fn);
  }

  subscribeRawAudio(deviceId: string, fn: RawAudioListener): () => void {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));
    return w.addRawAudioListener(fn);
  }

  openTalkSession(
    deviceId: string,
    callbacks: { onReady: () => void; onError: (msg: string) => void },
  ): { sendAlaw: (alaw: Uint8Array) => void; close: () => void } {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));
    const device = w.getDevice();
    let closed = false;
    let sock: tls.TLSSocket | null = null;
    let sessionId: string | null = null;
    const encoder = new TapoTalkEncoder();
    const pending: Uint8Array[] = [];
    let unregister: (() => void) | null = null;

    const close = () => {
      if (closed) return;
      closed = true;
      unregister?.();
      unregister = null;
      pending.length = 0;
      if (sock) {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        sock = null;
      }
    };
    unregister = this.registerCleanup(close);

    const sendAlaw = (alaw: Uint8Array) => {
      if (closed || alaw.length === 0) return;
      if (!sock || !sessionId) {
        if (pending.length < 16) pending.push(Uint8Array.from(alaw));
        return;
      }
      const ts = encoder.encodeAlaw(alaw);
      writeRelayAudioFrame(sock, sessionId, ts);
    };

    void (async () => {
      const creds = this.getCreds();
      if (!creds) {
        callbacks.onError(tServer(this.getLang(), "login_required_for_stream"));
        close();
        return;
      }
      try {
        let target;
        try {
          target = await this.client.requestRelay(creds.baseUrl, creds.token, device, {
            resolution: "VGA",
            streamType: 2,
          });
        } catch (err) {
          if (err instanceof TapoCloudError && err.isAuthError && (await this.onAuthExpired())) {
            const refreshed = this.getCreds();
            if (!refreshed) throw err;
            target = await this.client.requestRelay(refreshed.baseUrl, refreshed.token, device, {
              resolution: "VGA",
              streamType: 2,
            });
          } else {
            throw err;
          }
        }
        if (closed) return;

        sock = this.client.openRelayTls(target, device.deviceModel, {
          initialControlJson: JSON.stringify({
            type: "request",
            seq: 1,
            params: { talk: { mode: "aec" }, method: "get" },
          }),
        });

        const demux = createRelayPartDemuxer((hdrs, payload) => {
          if (closed) return;
          if ((hdrs["content-type"] ?? "").includes("application/json")) {
            try {
              const msg = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
              const params = (msg.params ?? {}) as Record<string, unknown>;
              const errCode = Number(params.error_code ?? msg.error_code ?? 0);
              if (errCode !== 0) {
                callbacks.onError(
                  tServer(this.getLang(), "camera_rejected_request", { code: errCode }),
                );
                close();
                return;
              }
              if (msg.type === "response" && params.session_id !== undefined && !sessionId && sock) {
                sessionId = String(params.session_id);
                writeRelayAudioFrame(sock, sessionId, encoder.getPsiHeader());
                this.pushLocalizedLog("info", "talk_connected", { alias: device.alias }, device.deviceId);
                callbacks.onReady();
                while (pending.length > 0 && !closed) {
                  const next = pending.shift()!;
                  writeRelayAudioFrame(sock, sessionId, encoder.encodeAlaw(next));
                }
              }
            } catch {
              // ignore non-JSON payload
            }
          }
        }, this.getLang);

        sock.on("data", (chunk: Buffer) => {
          try {
            demux(chunk);
          } catch (err) {
            callbacks.onError(err instanceof Error ? err.message : String(err));
            close();
          }
        });
        sock.on("error", (err) => {
          if (!closed) {
            callbacks.onError(err.message);
            close();
          }
        });
        sock.on("timeout", () => {
          if (!closed) {
            callbacks.onError(tServer(this.getLang(), "talk_timeout"));
            close();
          }
        });
        sock.on("close", () => {
          if (!closed) close();
        });
      } catch (err) {
        if (!closed) {
          callbacks.onError(err instanceof Error ? err.message : String(err));
          close();
        }
      }
    })();

    return { sendAlaw, close };
  }

  async captureSnapshot(deviceId: string): Promise<Buffer> {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));
    const cached = w.getLatestJpeg();
    if (cached && Date.now() - cached.ts < 5000) return cached.jpeg;

    return await new Promise<Buffer>((resolve, reject) => {
      let unsub: (() => void) | null = null;
      const timer = setTimeout(() => {
        unsub?.();
        reject(new Error(tServer(this.getLang(), "snapshot_timeout")));
      }, 16_000);
      unsub = w.addMjpegListener((jpeg) => {
        clearTimeout(timer);
        unsub?.();
        resolve(jpeg);
      });
    });
  }

  async captureMp4Clip(deviceId: string, durationSec = 4): Promise<Buffer> {
    const w = this.workers.get(deviceId);
    if (!w) throw new Error(tServer(this.getLang(), "camera_not_found"));

    const bin = this.ffmpegPath;
    if (!bin) {
      throw new Error(tServer(this.getLang(), "ffmpeg_missing"));
    }

    let aborted = false;
    let activeCleanup = () => {
      aborted = true;
    };
    const unregister = this.registerCleanup(() => activeCleanup());

    try {
      let tsBuf = w.getRollingTsBuffer();
      if (tsBuf.length < 300_000) {
        await new Promise<void>((resolve, reject) => {
          const unsub = w.addMjpegListener(() => {});
          const check = setInterval(() => {
            if (w.getRollingTsBuffer().length >= 350_000) {
              cleanupWait();
              resolve();
            }
          }, 250);
          const timeout = setTimeout(() => {
            cleanupWait();
            if (w.getRollingTsBuffer().length > 0) resolve();
            else reject(new Error(tServer(this.getLang(), "clip_capture_failed")));
          }, Math.max(durationSec, 5) * 1000 + 6000);
          const cleanupWait = () => {
            clearInterval(check);
            clearTimeout(timeout);
            unsub();
          };
          activeCleanup = () => {
            aborted = true;
            cleanupWait();
            reject(new Error(tServer(this.getLang(), "clip_capture_failed")));
          };
        });
        tsBuf = w.getRollingTsBuffer();
      }

      if (aborted) {
        throw new Error(tServer(this.getLang(), "clip_capture_failed"));
      }

      const proc = Bun.spawn(
        [
          bin,
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "mpegts",
          "-i",
          "pipe:0",
          "-map",
          "0:v:0",
          "-c:v",
          "copy",
          "-an",
          "-f",
          "mp4",
          "-movflags",
          "+frag_keyframe+empty_moov+default_base_moof",
          "pipe:1",
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );

      activeCleanup = () => {
        aborted = true;
        try {
          proc.stdin.end();
        } catch {
          // ignore
        }
        try {
          proc.kill();
        } catch {
          // ignore
        }
      };

      proc.stdin.write(tsBuf);
      proc.stdin.end();
      const out = await new Response(proc.stdout).arrayBuffer();
      const exit = await proc.exited;
      if (aborted || exit !== 0 || out.byteLength === 0) {
        throw new Error(tServer(this.getLang(), "clip_build_failed"));
      }
      return Buffer.from(out);
    } finally {
      unregister();
    }
  }
}
