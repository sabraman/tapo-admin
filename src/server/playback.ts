import { type ServerMessageKey, tServer } from "../shared/i18n";
import type { CameraMeta, ResolvedLanguage } from "../shared/types";
import { findFfmpegBinary } from "./config";
import { createRelayPartDemuxer, TapoCloudClient } from "./tapo-cloud";

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

// Streams an SD-card segment from Tapo's CIPC playback relay (streamType: 1)
// and remuxes video to fragmented MP4 so browsers can play or save it directly.
export async function streamSdRecordingMp4(params: {
  client: TapoCloudClient;
  baseUrl: string;
  token: string;
  terminalUuid: string;
  device: CameraMeta;
  start: number;
  end: number;
  download: boolean;
  ffmpegPath?: string | null;
  getLang?: () => ResolvedLanguage;
  signal?: AbortSignal;
  registerCleanup?: (cleanup: () => void) => () => void;
}): Promise<Response> {
  const {
    client,
    baseUrl,
    token,
    terminalUuid,
    device,
    start,
    end,
    download,
    ffmpegPath,
    getLang = () => "en",
    signal,
    registerCleanup,
  } = params;

  const lang = getLang();
  const bin = ffmpegPath !== undefined ? ffmpegPath : findFfmpegBinary();
  if (!bin) {
    throw new Error(tServer(lang, "ffmpeg_missing"));
  }

  throwIfAborted(signal, lang, "stream_closed");

  const clientId = await client.getPlaybackUserId(baseUrl, token, terminalUuid, device.deviceId);
  throwIfAborted(signal, lang, "stream_closed");

  const trackId = `tapo-admin-pb-${device.deviceId}-${start}`;
  const target = await client.requestRelay(baseUrl, token, device, {
    resolution: "HD",
    streamType: 1,
    trackId,
  });
  throwIfAborted(signal, lang, "stream_closed");

  const seq = 1000 + (start % 20000);
  const playbackJson = JSON.stringify({
    type: "request",
    seq,
    params: {
      playback: {
        client_id: clientId,
        channels: [0, 1],
        scale: "1/1",
        start_time: String(start),
        end_time: String(end),
        event_type: [1, 2],
      },
      method: "get",
    },
  });

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
      "-flush_packets",
      "1",
      "-movflags",
      "+empty_moov+default_base_moof+frag_keyframe",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );

  const sock = client.openRelayTls(target, device.deviceModel, {
    trackId,
    initialControlJson: playbackJson,
  });

  let cleaned = false;
  let unregister: (() => void) | null = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unregister?.();
    unregister = null;
    signal?.removeEventListener("abort", cleanup);
    try {
      sock.destroy();
    } catch {
      // ignore
    }
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

  unregister = registerCleanup?.(cleanup) ?? null;
  signal?.addEventListener("abort", cleanup, { once: true });
  void proc.exited.finally(cleanup);

  const demux = createRelayPartDemuxer((_hdrs, payload) => {
    if (cleaned) return;
    try {
      proc.stdin.write(payload);
    } catch {
      cleanup();
    }
  }, getLang);

  sock.on("data", (chunk: Buffer) => {
    if (cleaned) return;
    try {
      const r = demux(chunk);
      if (r.encrypted) sock.destroy();
    } catch {
      sock.destroy();
    }
  });
  sock.on("close", () => {
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
  });
  sock.on("error", () => cleanup());
  sock.on("timeout", () => cleanup());

  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
  };
  if (download) {
    headers["Content-Disposition"] = safeAttachmentDisposition(`tapo-${device.alias}-${start}.mp4`);
  }

  return new Response(proc.stdout, { status: 200, headers });
}
