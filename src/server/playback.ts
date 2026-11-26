import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { DEVICE_ERROR_KEYS, type ServerMessageKey, tServer } from "../shared/i18n";
import type { CameraMeta, ResolvedLanguage } from "../shared/types";
import { findFfmpegBinary } from "./config";
import { MulawTsExtractor } from "./mulaw-extractor";
import {
  createRelayPartDemuxer,
  TapoCloudClient,
  TapoCloudError,
  writeRelaySequenceAck,
} from "./tapo-cloud";

const END_OF_PLAYBACK_EVENTS = new Set([
  "playback_finish",
  "playback_end",
  "stream_finish",
  "file_end",
  "playback_stop",
]);

function safeAttachmentDisposition(filename: string): string {
  const asciiFallback =
    filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "recording.mp4";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function throwIfAborted(signal: AbortSignal | undefined, lang: ResolvedLanguage, key: ServerMessageKey): void {
  if (signal?.aborted) {
    throw new Error(tServer(lang, key));
  }
}

function spawnMp4Muxer(
  bin: string,
  includeAudio: boolean,
  audioSampleRate = 16000,
  rotate180 = false,
): ChildProcess {
  const rotateArgs = rotate180 ? ["-display_rotation", "180"] : [];
  if (includeAudio) {
    return spawn(
      bin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...rotateArgs,
        "-fflags",
        "+nobuffer",
        "-analyzeduration",
        "200000",
        "-probesize",
        "65536",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-analyzeduration",
        "0",
        "-probesize",
        "4096",
        "-f",
        "mulaw",
        "-ar",
        String(audioSampleRate),
        "-ac",
        "1",
        "-i",
        "pipe:3",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-avoid_negative_ts",
        "make_zero",
        "-flush_packets",
        "1",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-movflags",
        "+empty_moov+default_base_moof+frag_keyframe",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );
  }
  return spawn(
    bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...rotateArgs,
      "-fflags",
      "+nobuffer",
      "-analyzeduration",
      "200000",
      "-probesize",
      "65536",
      "-f",
      "mpegts",
      "-i",
      "pipe:0",
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-an",
      "-avoid_negative_ts",
      "make_zero",
      "-flush_packets",
      "1",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-movflags",
      "+empty_moov+default_base_moof+frag_keyframe",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

/**
 * Remuxes a buffered Tapo MPEG-TS chunk (including private 0x91/0xC0 G.711 u-law audio
 * when present) into a fragmented MP4 buffer.
 */
export async function remuxTapoTsBufferToMp4(bin: string, tsBuffer: Buffer): Promise<Buffer> {
  const extractor = new MulawTsExtractor();
  const mulaw = extractor.feed(tsBuffer);
  const includeAudio = mulaw.length > 0;
  const proc = spawnMp4Muxer(bin, includeAudio, extractor.getEstimatedSampleRate());

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderrText = "";
    proc.stdin?.on("error", () => {});
    const audioPipe = includeAudio ? (proc.stdio[3] as Writable | undefined) : undefined;
    audioPipe?.on("error", () => {});
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => {
      if (stderrText.length < 2048) stderrText += d.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const out = Buffer.concat(chunks);
      if (code !== 0 || out.length === 0) {
        const detail = stderrText.trim();
        reject(new Error(`ffmpeg exited with code ${code ?? -1}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(out);
    });
    proc.stdin?.end(tsBuffer);
    if (includeAudio) {
      audioPipe?.end(mulaw);
    }
  });
}

class PlaybackAttemptError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly emptyFinished = false,
  ) {
    super(message);
  }
}

export interface StreamSdRecordingParams {
  client: TapoCloudClient;
  baseUrl: string;
  token: string;
  terminalUuid: string;
  device: CameraMeta;
  start: number;
  end: number;
  download: boolean;
  rotate180?: boolean;
  ffmpegPath?: string | null;
  getLang?: () => ResolvedLanguage;
  signal?: AbortSignal;
  registerCleanup?: (cleanup: () => void) => () => void;
  acquirePlaybackSlot?: (abortCurrent: () => void) => Promise<() => void>;
  suspendLiveStream?: () => Promise<() => void>;
  /** @deprecated Prefer acquirePlaybackSlot + suspendLiveStream */
  acquirePlaybackHold?: (abortCurrent: () => void) => Promise<() => void>;
  startupTimeoutMs?: number;
  probeMs?: number;
}

// Streams an SD-card segment from Tapo's CIPC playback relay (streamType: 1)
// and remuxes video + G.711 u-law audio into fragmented MP4 for browser playback or download.
export async function streamSdRecordingMp4(params: StreamSdRecordingParams): Promise<Response> {
  const {
    client,
    baseUrl,
    token,
    terminalUuid,
    device,
    start,
    end,
    download,
    rotate180 = false,
    ffmpegPath,
    getLang = () => "en",
    signal,
    registerCleanup,
    acquirePlaybackSlot,
    suspendLiveStream,
    acquirePlaybackHold,
    startupTimeoutMs = 20_000,
    probeMs = 900,
  } = params;

  const lang = getLang();
  const bin = ffmpegPath !== undefined ? ffmpegPath : findFfmpegBinary();
  if (!bin) {
    throw new Error(tServer(lang, "ffmpeg_missing"));
  }

  throwIfAborted(signal, lang, "stream_closed");

  let activeCleanup: (() => void) | null = null;
  let outerAborted = false;
  const abortAllAttempts = () => {
    outerAborted = true;
    activeCleanup?.();
  };

  let releaseSlotFn: (() => void) | null = null;
  let releaseLiveSuspendFn: (() => void) | null = null;
  let holdsReleased = false;
  const releaseAllHolds = () => {
    if (holdsReleased) return;
    holdsReleased = true;
    try {
      releaseLiveSuspendFn?.();
    } finally {
      releaseLiveSuspendFn = null;
    }
    try {
      releaseSlotFn?.();
    } finally {
      releaseSlotFn = null;
    }
  };

  const onOuterAbort = () => abortAllAttempts();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  const slotAcquirer = acquirePlaybackSlot ?? acquirePlaybackHold;
  if (slotAcquirer) {
    releaseSlotFn = await slotAcquirer(abortAllAttempts);
  }

  let responseReturned = false;
  try {
    throwIfAborted(signal, lang, "stream_closed");
    if (outerAborted) {
      throw new Error(tServer(lang, "stream_closed"));
    }

    const resolveSession = async (forceRefresh: boolean): Promise<{ clientId: number; fromCache: boolean }> => {
      if (typeof client.preparePlaybackSession === "function") {
        return await client.preparePlaybackSession(
          baseUrl,
          token,
          terminalUuid,
          device.deviceId,
          start,
          end,
          { forceRefresh },
        );
      }
      const clientId = await client
        .getPlaybackUserId(baseUrl, token, terminalUuid, device.deviceId)
        .catch((err) => {
          console.warn("[playback] getPlaybackUserId failed, falling back to 1:", err);
          return 1;
        });
      return { clientId, fromCache: false };
    };

    let sessionInfo = await resolveSession(false);
    throwIfAborted(signal, lang, "stream_closed");

    const retryDelaysMs = [900, 1600, 2400];
    const maxAttempts = 1 + retryDelaysMs.length;
    let lastError: unknown = null;
    let refreshedEmptyIndex = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal, lang, "stream_closed");
      if (outerAborted) {
        throw new Error(tServer(lang, "stream_closed"));
      }

      try {
        const res = await attemptStreamSdRecording({
          client,
          baseUrl,
          token,
          terminalUuid,
          device,
          clientId: sessionInfo.clientId,
          start,
          end,
          download,
          rotate180,
          bin,
          getLang,
          signal,
          isOuterAborted: () => outerAborted,
          registerCleanup,
          startupTimeoutMs,
          probeMs,
          attempt,
          setActiveCleanup: (fn) => {
            activeCleanup = fn;
          },
          onStreamEnd: releaseAllHolds,
        });
        responseReturned = true;
        return res;
      } catch (err) {
        lastError = err;
        activeCleanup = null;
        if (signal?.aborted || outerAborted || attempt >= maxAttempts) {
          throw err;
        }

        // If camera immediately returned stream_status="finished" with 0 bytes, re-index with fresh clientId once.
        if (err instanceof PlaybackAttemptError && err.emptyFinished && !refreshedEmptyIndex) {
          refreshedEmptyIndex = true;
          console.warn(
            `[playback] ${device.deviceId} attempt ${attempt} returned empty stream_status=finished; re-indexing playback session`,
          );
          if (typeof client.invalidatePlaybackSession === "function") {
            client.invalidatePlaybackSession(device.deviceId);
          }
          sessionInfo = await resolveSession(true);
          continue;
        }

        const errCode =
          err instanceof PlaybackAttemptError || err instanceof TapoCloudError
            ? err.code
            : undefined;
        const isBusy = errCode === -52405;
        if (!isBusy) {
          throw err;
        }

        // Only pause live stream as a fallback when this specific camera rejects concurrent streams with -52405.
        if (!releaseLiveSuspendFn && suspendLiveStream) {
          console.warn(
            `[playback] ${device.deviceId} attempt ${attempt} hit -52405 (busy); temporarily pausing live stream`,
          );
          releaseLiveSuspendFn = await suspendLiveStream();
          await Bun.sleep(400);
          continue;
        }

        const waitMs = retryDelaysMs[attempt - 1] ?? 1500;
        console.warn(
          `[playback] ${device.deviceId} attempt ${attempt} hit -52405 (busy); retrying in ${waitMs}ms`,
        );
        await Bun.sleep(waitMs);
      }
    }

    throw lastError ?? new Error(tServer(lang, "clip_build_failed"));
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
    if (!responseReturned) {
      releaseAllHolds();
    }
  }
}

async function attemptStreamSdRecording(params: {
  client: TapoCloudClient;
  baseUrl: string;
  token: string;
  terminalUuid: string;
  device: CameraMeta;
  clientId: number;
  start: number;
  end: number;
  download: boolean;
  rotate180: boolean;
  bin: string;
  getLang: () => ResolvedLanguage;
  signal?: AbortSignal;
  isOuterAborted: () => boolean;
  registerCleanup?: (cleanup: () => void) => () => void;
  startupTimeoutMs: number;
  probeMs: number;
  attempt: number;
  setActiveCleanup: (fn: (() => void) | null) => void;
  onStreamEnd: () => void;
}): Promise<Response> {
  const {
    client,
    baseUrl,
    token,
    terminalUuid,
    device,
    clientId,
    start,
    end,
    download,
    rotate180,
    bin,
    getLang,
    signal,
    isOuterAborted,
    registerCleanup,
    startupTimeoutMs,
    probeMs,
    attempt,
    setActiveCleanup,
    onStreamEnd,
  } = params;

  const lang = getLang();
  const trackId = `tapo-admin-pb-${device.deviceId}-${start}-${randomUUID().slice(0, 8)}`;
  const target = await client.requestRelay(baseUrl, token, device, {
    resolution: "HD",
    streamType: 1,
    trackId,
  });
  throwIfAborted(signal, lang, "stream_closed");
  if (isOuterAborted()) {
    throw new Error(tServer(lang, "stream_closed"));
  }

  const seq = 1000 + Math.floor(Math.random() * 20000);
  const playbackJson = JSON.stringify({
    type: "request",
    seq,
    params: {
      playback: {
        client_id: clientId,
        channels: [0],
        scale: "1/1",
        start_time: String(start),
        end_time: String(end),
        event_type: [1, 2],
      },
      method: "get",
    },
  });

  const sock = client.openRelayTls(target, device.deviceModel, {
    trackId,
    initialControlJson: playbackJson,
  });

  const extractor = new MulawTsExtractor();
  let proc: ChildProcess | null = null;
  let audioPipe: Writable | null = null;
  let audioPipeClosed = false;
  let includeAudio = false;
  let sockEnded = false;
  let cleaned = false;
  let unregister: (() => void) | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let audioRateTimer: ReturnType<typeof setTimeout> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;

  let pendingTs: Buffer[] = [];
  let pendingTsBytes = 0;
  let pendingAudio: Buffer[] = [];
  let pendingAudioBytes = 0;
  const MAX_PROBE_BYTES = 512 * 1024;

  let sessionId = "";
  let lastAckSeq = -1;
  let lastAudioAt = 0;
  let videoChunksSinceAudio = 0;
  let stderrTail = "";
  let firstErrorMsg: string | null = null;
  let firstErrorCode: number | undefined;
  let emptyStreamFinished = false;
  let emittedOutBytes = 0;
  let startupSettled = false;
  let earlyOutChunks: Uint8Array[] = [];

  let relayHttpOk = false;
  let relayJsonOk = false;
  let tsPartsReceived = 0;
  let tsBytesReceived = 0;
  let mulawBytesReceived = 0;
  let muxerStarted = false;

  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;

  let resolveStartup!: () => void;
  let rejectStartup!: (err: Error) => void;
  const startupPromise = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });

  const clearTimers = () => {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
    if (audioRateTimer) {
      clearTimeout(audioRateTimer);
      audioRateTimer = null;
    }
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
  };

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      streamController?.close();
    } catch {
      // already closed
    }
  };

  const endInputs = () => {
    if (!audioPipeClosed) {
      audioPipeClosed = true;
      try {
        audioPipe?.end();
      } catch {
        // ignore
      }
    }
    try {
      proc?.stdin?.end();
    } catch {
      // ignore
    }
  };

  const cleanup = (failureMsg?: string, errCode?: number) => {
    if (failureMsg && !firstErrorMsg) {
      firstErrorMsg = failureMsg;
      firstErrorCode = errCode;
    }
    if (cleaned) return;
    cleaned = true;
    setActiveCleanup(null);
    clearTimers();
    pendingTs = [];
    pendingAudio = [];
    unregister?.();
    unregister = null;
    signal?.removeEventListener("abort", onAbort);
    try {
      sock.destroy();
    } catch {
      // ignore
    }
    endInputs();
    try {
      proc?.kill();
    } catch {
      // ignore
    }
    if (!startupSettled) {
      startupSettled = true;
      const reason =
        firstErrorMsg ??
        (stderrTail.trim()
          ? `${tServer(lang, "clip_build_failed")}: ${stderrTail.trim()}`
          : tServer(lang, "playback_no_media"));
      console.error(
        `[playback] ${device.deviceId} attempt ${attempt} failed (http=${relayHttpOk}, json=${relayJsonOk}, tsParts=${tsPartsReceived}, tsBytes=${tsBytesReceived}, mulawBytes=${mulawBytesReceived}, mux=${muxerStarted}, emptyFinished=${emptyStreamFinished}): ${reason}`,
      );
      rejectStartup(new PlaybackAttemptError(reason, firstErrorCode, emptyStreamFinished));
    } else {
      onStreamEnd();
    }
    closeStream();
  };

  setActiveCleanup(() => cleanup(tServer(lang, "stream_closed")));
  const onAbort = () => cleanup(tServer(lang, "stream_closed"));
  unregister = registerCleanup?.(() => cleanup()) ?? null;
  signal?.addEventListener("abort", onAbort, { once: true });

  startupTimer = setTimeout(() => {
    cleanup(tServer(lang, "stream_timeout"));
  }, startupTimeoutMs);

  const finishRelayInputs = () => {
    sockEnded = true;
    try {
      sock.end();
    } catch {
      // ignore
    }
    if (!proc && !cleaned) {
      if (pendingTs.length > 0) {
        startMuxer(pendingAudioBytes > 0);
      } else {
        cleanup(tServer(lang, "playback_no_media"));
      }
      return;
    }
    endInputs();
  };

  const startMuxer = (withAudio: boolean) => {
    if (cleaned || proc) return;
    muxerStarted = true;
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
    if (audioRateTimer) {
      clearTimeout(audioRateTimer);
      audioRateTimer = null;
    }
    includeAudio = withAudio && pendingAudioBytes > 0;
    const sampleRate = includeAudio ? extractor.getEstimatedSampleRate() : 16000;
    proc = spawnMp4Muxer(bin, includeAudio, sampleRate, rotate180);
    proc.stdin?.on("error", () => {});
    audioPipe = includeAudio ? ((proc.stdio[3] as Writable | undefined) ?? null) : null;
    audioPipe?.on("error", () => {});
    lastAudioAt = Date.now();
    videoChunksSinceAudio = 0;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (cleaned || streamClosed || chunk.length === 0) return;
      emittedOutBytes += chunk.length;
      const bytes = new Uint8Array(chunk);
      if (streamController) {
        try {
          streamController.enqueue(bytes);
        } catch {
          cleanup();
        }
      } else {
        earlyOutChunks.push(bytes);
      }
      if (!startupSettled) {
        startupSettled = true;
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        resolveStartup();
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      if (stderrTail.length < 2048) {
        stderrTail += d.toString("utf8");
      }
    });

    proc.stdout?.on("end", () => {
      if (emittedOutBytes === 0 && !startupSettled) {
        cleanup(
          stderrTail.trim()
            ? `${tServer(lang, "clip_build_failed")}: ${stderrTail.trim()}`
            : tServer(lang, "playback_no_media"),
        );
        return;
      }
      closeStream();
    });
    proc.on("close", (code) => {
      if (code && code !== 0 && !firstErrorMsg) {
        const detail = stderrTail.trim();
        cleanup(
          detail
            ? `${tServer(lang, "clip_build_failed")} (ffmpeg ${code}: ${detail})`
            : `${tServer(lang, "clip_build_failed")} (ffmpeg ${code})`,
        );
        return;
      }
      cleanup();
    });
    proc.on("error", (err) => cleanup(err.message));

    for (const buf of pendingTs) {
      proc.stdin?.write(buf);
    }
    pendingTs = [];
    pendingTsBytes = 0;

    if (includeAudio && pendingAudio.length > 0) {
      const mergedAudio = pendingAudio.length === 1 ? pendingAudio[0]! : Buffer.concat(pendingAudio);
      audioPipe?.write(mergedAudio);
    }
    pendingAudio = [];
    pendingAudioBytes = 0;

    if (sockEnded) {
      endInputs();
    }
  };

  const demux = createRelayPartDemuxer((hdrs, payload) => {
    if (cleaned) return;
    if (!sessionId && hdrs["x-session-id"]) {
      sessionId = hdrs["x-session-id"];
    }
    const seqHeader = hdrs["x-data-sequence"];
    if (seqHeader !== undefined) {
      const seqNum = Number(seqHeader);
      if (Number.isFinite(seqNum) && seqNum - lastAckSeq >= 10) {
        lastAckSeq = seqNum;
        writeRelaySequenceAck(sock, seqNum, sessionId || undefined);
      }
    }

    const contentType = hdrs["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      try {
        const msg = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        const resultObj = (msg.result ?? {}) as Record<string, unknown>;
        const paramsObj = (msg.params ?? {}) as Record<string, unknown>;
        const respSession = resultObj.session_id ?? paramsObj.session_id;
        if (!sessionId && respSession !== undefined && respSession !== null) {
          sessionId = String(respSession);
        }
        const errCode = Number(resultObj.error_code ?? paramsObj.error_code ?? msg.error_code ?? 0);
        if (Number.isFinite(errCode) && errCode !== 0) {
          const mappedKey = DEVICE_ERROR_KEYS[errCode];
          const msgText = mappedKey
            ? tServer(lang, mappedKey)
            : tServer(lang, "camera_rejected_request", { code: errCode });
          if (emittedOutBytes > 0) {
            finishRelayInputs();
          } else {
            cleanup(msgText, errCode);
          }
          return;
        }
        if (msg.type === "response") {
          relayJsonOk = true;
        }
        const eventType = String(paramsObj.event_type ?? "");
        const streamStatus = String(paramsObj.status ?? "").toLowerCase();
        const isStreamFinished =
          END_OF_PLAYBACK_EVENTS.has(eventType) ||
          (eventType === "stream_status" &&
            (streamStatus === "finished" || streamStatus === "end" || streamStatus === "stopped"));
        if (msg.type === "notification" && isStreamFinished) {
          if (tsBytesReceived === 0) {
            emptyStreamFinished = true;
          }
          finishRelayInputs();
        }
      } catch {
        // ignore non-JSON control chunk
      }
      return;
    }

    tsPartsReceived += 1;
    tsBytesReceived += payload.length;
    const mulaw = extractor.feed(payload);
    mulawBytesReceived += mulaw.length;
    if (!proc) {
      pendingTs.push(Buffer.from(payload));
      pendingTsBytes += payload.length;
      if (mulaw.length > 0) {
        pendingAudio.push(mulaw);
        pendingAudioBytes += mulaw.length;
        // Wait briefly for ~1600 bytes (2+ PES packets) so 8kHz vs 16kHz can be identified cleanly
        if (pendingAudioBytes >= 1600 || pendingTsBytes >= MAX_PROBE_BYTES) {
          startMuxer(true);
          return;
        }
        if (!audioRateTimer) {
          audioRateTimer = setTimeout(() => startMuxer(true), 300);
        }
        return;
      }
      if (!probeTimer) {
        probeTimer = setTimeout(() => startMuxer(pendingAudioBytes > 0), probeMs);
      }
      if (pendingTsBytes >= MAX_PROBE_BYTES) {
        startMuxer(pendingAudioBytes > 0);
      }
      return;
    }

    try {
      proc.stdin?.write(payload);
      if (includeAudio && !audioPipeClosed && audioPipe) {
        if (mulaw.length > 0) {
          lastAudioAt = Date.now();
          videoChunksSinceAudio = 0;
          audioPipe.write(mulaw);
        } else {
          videoChunksSinceAudio++;
          if (videoChunksSinceAudio >= 50 && Date.now() - lastAudioAt >= 3500) {
            audioPipeClosed = true;
            audioPipe.end();
          }
        }
      }
    } catch {
      cleanup();
    }
  }, getLang);

  sock.on("data", (chunk: Buffer) => {
    if (cleaned) return;
    try {
      const r = demux(chunk);
      if (r.httpStatus) relayHttpOk = true;
      if (r.encrypted) {
        cleanup(tServer(lang, "stream_encrypted"));
      }
    } catch (err) {
      cleanup(err instanceof Error ? err.message : String(err));
    }
  });
  sock.on("close", finishRelayInputs);
  sock.on("error", (err) => cleanup(err instanceof Error ? err.message : tServer(lang, "stream_closed")));
  sock.on("timeout", () => cleanup(tServer(lang, "stream_timeout")));

  await startupPromise;

  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (earlyOutChunks.length > 0) {
        for (const chunk of earlyOutChunks) {
          try {
            controller.enqueue(chunk);
          } catch {
            cleanup();
            break;
          }
        }
        earlyOutChunks = [];
      }
      if (streamClosed || cleaned) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      cleanup();
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "Accept-Ranges": "none",
  };
  if (download) {
    headers["Content-Disposition"] = safeAttachmentDisposition(`tapo-${device.alias}-${start}.mp4`);
  }

  return new Response(bodyStream, { status: 200, headers });
}

export async function captureSdRecordingMp4Buffer(params: {
  client: TapoCloudClient;
  baseUrl: string;
  token: string;
  terminalUuid: string;
  device: CameraMeta;
  start: number;
  end: number;
  rotate180?: boolean;
  ffmpegPath?: string | null;
  getLang?: () => ResolvedLanguage;
  signal?: AbortSignal;
  registerCleanup?: (cleanup: () => void) => () => void;
  acquirePlaybackSlot?: (abortCurrent: () => void) => Promise<() => void>;
  suspendLiveStream?: () => Promise<() => void>;
  acquirePlaybackHold?: (abortCurrent: () => void) => Promise<() => void>;
  maxBytes?: number;
}): Promise<Buffer> {
  const maxBytes = params.maxBytes ?? 64 * 1024 * 1024;
  const response = await streamSdRecordingMp4({
    ...params,
    download: false,
  });
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(tServer(params.getLang?.() ?? "en", "clip_build_failed"));
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(tServer(params.getLang?.() ?? "en", "clip_build_failed"));
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  const out = Buffer.concat(chunks);
  if (out.length === 0) {
    throw new Error(tServer(params.getLang?.() ?? "en", "clip_build_failed"));
  }
  return out;
}
