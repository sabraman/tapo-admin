import { EncodedPacketSink, Input, MPEG_TS, ReadableStreamSource } from "mediabunny";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { canUseWebCodecs } from "@/lib/api";
import { isSimulatedCamera } from "@/lib/debug-emulator";
import { useI18n } from "@/lib/i18n";
import {
  acquireMirrorLeader,
  getLiveMirrorElementSize,
  getLiveMirrorSource,
  isLiveMirrorElementReady,
  registerLiveMirrorSource,
  releaseMirrorLeader,
  subscribeLiveMirrorChange,
} from "@/lib/live-mirror";
import { cn } from "@/lib/utils";
import type { GridTransport, RelayStatus } from "../../shared/types";

class WebCodecsUnsupportedError extends Error {}

interface VideoStreamStageProps {
  deviceId: string;
  mirrorDeviceId?: string;
  quality: "grid" | "hd";
  transport: GridTransport;
  targetFps?: number;
  online: boolean;
  telemetryStatus?: RelayStatus;
  lastError?: string | null;
  panOffset?: { x: number; y: number };
  rotate180?: boolean;
  className?: string;
}

function mediaRotationStyle(
  rotate180: boolean,
  panOffset?: { x: number; y: number },
): React.CSSProperties | undefined {
  const parts: string[] = [];
  if (panOffset && (panOffset.x !== 0 || panOffset.y !== 0)) {
    parts.push(`scale(1.12) translate(${panOffset.x}px, ${panOffset.y}px)`);
  }
  if (rotate180) {
    parts.push("rotate(180deg)");
  }
  return parts.length > 0 ? { transform: parts.join(" "), transformOrigin: "center" } : undefined;
}

export function VideoStreamStage({
  deviceId,
  mirrorDeviceId,
  quality,
  transport,
  targetFps = 30,
  online,
  telemetryStatus,
  lastError,
  panOffset,
  rotate180 = false,
  className,
}: VideoStreamStageProps): React.ReactElement {
  const { t } = useI18n();
  const [fallbackActive, setFallbackActive] = useState(false);

  // Reset fallback preference whenever camera or explicit transport setting changes.
  useEffect(() => {
    setFallbackActive(false);
  }, [deviceId, mirrorDeviceId, quality, transport]);

  const isSim = isSimulatedCamera(deviceId);
  const useWebCodecs = canUseWebCodecs() && transport === "webcodecs" && !fallbackActive;

  if (!online || telemetryStatus === "offline") {
    return (
      <div
        className={cn(
          "relative flex aspect-video w-full items-center justify-center overflow-hidden bg-neutral-950 text-xs text-muted-foreground",
          className,
        )}
      >
        <span>{t("stageCameraOffline")}</span>
      </div>
    );
  }

  if (isSim && telemetryStatus === "error") {
    return (
      <div
        className={cn(
          "relative flex aspect-video w-full flex-col items-center justify-center gap-1 overflow-hidden bg-neutral-950 text-xs text-destructive-foreground",
          className,
        )}
      >
        <span>{lastError || t("stageSimStreamError")}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden bg-black select-none",
        className,
      )}
    >
      {isSim && mirrorDeviceId ? (
        <MirroredStreamStage
          lastError={lastError}
          panOffset={panOffset}
          quality={quality}
          rotate180={rotate180}
          sourceDeviceId={mirrorDeviceId}
          targetFps={targetFps}
          telemetryStatus={telemetryStatus}
          transport={transport}
        />
      ) : isSim ? (
        <SimulatedStreamStage
          deviceId={deviceId}
          panOffset={panOffset}
          quality={quality}
          rotate180={rotate180}
          targetFps={targetFps}
        />
      ) : useWebCodecs ? (
        <MediabunnyTsStage
          deviceId={deviceId}
          keyframeOnly={quality === "grid" && targetFps <= 1}
          lastError={lastError}
          onFallback={() => setFallbackActive(true)}
          quality={quality}
          rotate180={rotate180}
          targetFps={quality === "hd" ? 60 : targetFps}
          telemetryStatus={telemetryStatus}
        />
      ) : quality === "hd" ? (
        <MseFmp4Stage deviceId={deviceId} rotate180={rotate180} />
      ) : (
        <MjpegStage
          deviceId={deviceId}
          lastError={lastError}
          rotate180={rotate180}
          telemetryStatus={telemetryStatus}
        />
      )}
    </div>
  );
}

function MediabunnyTsStage({
  deviceId,
  quality,
  targetFps,
  keyframeOnly,
  rotate180,
  panOffset,
  isMirrorLeader = false,
  telemetryStatus,
  lastError,
  onFallback,
}: {
  deviceId: string;
  quality: "grid" | "hd";
  targetFps: number;
  keyframeOnly: boolean;
  rotate180: boolean;
  panOffset?: { x: number; y: number };
  isMirrorLeader?: boolean;
  telemetryStatus?: RelayStatus;
  lastError?: string | null;
  onFallback: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const targetFpsRef = useRef(targetFps);
  const keyframeOnlyRef = useRef(keyframeOnly);
  const onFallbackRef = useRef(onFallback);
  const tRef = useRef(t);
  targetFpsRef.current = targetFps;
  keyframeOnlyRef.current = keyframeOnly;
  onFallbackRef.current = onFallback;
  tRef.current = t;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return registerLiveMirrorSource(deviceId, canvas, !isMirrorLeader);
  }, [deviceId, isMirrorLeader]);

  useEffect(() => {
    setHasFrame(false);
    setErrorMsg(null);

    let unmounted = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let gotAnyFrame = false;

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let activeInput: Input | null = null;
    let activeDecoder: VideoDecoder | null = null;
    let pipelineGen = 0;

    const teardownPipeline = () => {
      pipelineGen += 1;
      try {
        streamController?.close();
      } catch {
        // stream already closed
      }
      streamController = null;
      if (activeInput) {
        try {
          activeInput.dispose();
        } catch {
          // ignore
        }
        activeInput = null;
      }
      if (activeDecoder) {
        try {
          if (activeDecoder.state !== "closed") activeDecoder.close();
        } catch {
          // ignore
        }
        activeDecoder = null;
      }
    };

    const startPipeline = () => {
      teardownPipeline();
      const myGen = pipelineGen;
      const readable = new ReadableStream<Uint8Array>({
        start(ctrl) {
          streamController = ctrl;
        },
      });

      const input = new Input({
        source: new ReadableStreamSource(readable),
        formats: [MPEG_TS],
      });
      activeInput = input;

      void (async () => {
        try {
          const videoTrack = await input.getPrimaryVideoTrack();
          if (unmounted || myGen !== pipelineGen || !videoTrack) return;

          const rawConfig = await videoTrack.getDecoderConfig();
          if (unmounted || myGen !== pipelineGen || !rawConfig) return;

          const baseConfig: VideoDecoderConfig = {
            codec: rawConfig.codec,
            ...(rawConfig.description ? { description: rawConfig.description } : {}),
            ...(rawConfig.codedWidth ? { codedWidth: rawConfig.codedWidth } : {}),
            ...(rawConfig.codedHeight ? { codedHeight: rawConfig.codedHeight } : {}),
            hardwareAcceleration: "prefer-hardware",
            optimizeForLatency: true,
          };

          let finalConfig = baseConfig;
          const hwCheck = await VideoDecoder.isConfigSupported(baseConfig);
          if (!hwCheck.supported) {
            finalConfig = { ...baseConfig, hardwareAcceleration: "no-preference" };
            const swCheck = await VideoDecoder.isConfigSupported(finalConfig);
            if (!swCheck.supported) {
              throw new WebCodecsUnsupportedError(tRef.current("stageWebCodecsUnsupported"));
            }
          }

          if (unmounted || myGen !== pipelineGen) return;

          let lastDrawAt = -Infinity;
          let decodedAnyFrame = false;
          const decoder = new VideoDecoder({
            output(frame) {
              try {
                if (unmounted || myGen !== pipelineGen) return;
                const canvas = canvasRef.current;
                if (!canvas) return;
                const now = performance.now();
                const fps = targetFpsRef.current;
                const minInterval = fps >= 30 ? 0 : (1000 / Math.max(0.2, fps)) * 0.85;
                if (minInterval > 0 && now - lastDrawAt < minInterval) return;
                lastDrawAt = now;

                const w = frame.displayWidth || 1280;
                const h = frame.displayHeight || 720;
                if (canvas.width !== w || canvas.height !== h) {
                  canvas.width = w;
                  canvas.height = h;
                }
                const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
                if (ctx) {
                  ctx.drawImage(frame, 0, 0, w, h);
                  decodedAnyFrame = true;
                  if (!gotAnyFrame) {
                    gotAnyFrame = true;
                    setHasFrame(true);
                    setErrorMsg(null);
                  }
                  consecutiveFailures = 0;
                }
              } finally {
                frame.close();
              }
            },
            error(err) {
              if (unmounted || myGen !== pipelineGen) return;
              consecutiveFailures += 1;
              if (!decodedAnyFrame || consecutiveFailures >= 2) {
                onFallbackRef.current();
              } else {
                setErrorMsg(err.message);
              }
            },
          });
          decoder.configure(finalConfig);
          activeDecoder = decoder;

          const sink = new EncodedPacketSink(videoTrack);
          let sawFirstKey = false;
          let waitingForKeyRecovery = false;
          let lastKeyDecodeAt = -Infinity;

          for await (const packet of sink.packets(undefined, undefined, {
            verifyKeyPackets: true,
          })) {
            if (unmounted || myGen !== pipelineGen) break;
            if (decoder.state !== "configured") break;

            const isKey = packet.type === "key";
            if (!sawFirstKey) {
              if (!isKey) continue;
              sawFirstKey = true;
            }

            if (keyframeOnlyRef.current) {
              if (!isKey) continue;
              const minInterval = (1000 / Math.max(0.2, targetFpsRef.current)) * 0.85;
              const now = performance.now();
              if (now - lastKeyDecodeAt < minInterval) continue;
              lastKeyDecodeAt = now;
            } else {
              // Avoid decoder queue backlog on slow tabs by dropping deltas until next keyframe.
              if (decoder.decodeQueueSize > 4) {
                waitingForKeyRecovery = true;
              }
              if (waitingForKeyRecovery) {
                if (!isKey) continue;
                waitingForKeyRecovery = false;
              }
            }

            decoder.decode(packet.toEncodedVideoChunk());
          }
        } catch (err) {
          if (unmounted || myGen !== pipelineGen) return;
          const msg = err instanceof Error ? err.message : String(err);
          consecutiveFailures += 1;
          if (err instanceof WebCodecsUnsupportedError || consecutiveFailures >= 2) {
            onFallbackRef.current();
          } else {
            setErrorMsg(msg);
          }
        }
      })();
    };

    const connect = () => {
      if (unmounted) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws/ts/${encodeURIComponent(deviceId)}?quality=${quality}`);
      ws.binaryType = "arraybuffer";

      startPipeline();

      ws.onmessage = (ev) => {
        if (unmounted || !(ev.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(ev.data);
        if (bytes.length === 0) return;
        const kind = bytes[0];
        if (kind === 0x01 && streamController) {
          try {
            streamController.enqueue(bytes.subarray(1));
          } catch {
            // pipeline closing
          }
        } else if (kind === 0x03) {
          startPipeline();
        }
      };

      ws.onerror = () => {
        if (!unmounted && !gotAnyFrame) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 2) onFallbackRef.current();
        }
      };

      ws.onclose = () => {
        teardownPipeline();
        if (!unmounted) {
          reconnectTimer = setTimeout(connect, 2200);
        }
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
      teardownPipeline();
    };
  }, [deviceId, quality]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block h-full w-full object-contain"
        style={mediaRotationStyle(rotate180, panOffset)}
      />
      {!hasFrame && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950/70 text-xs text-muted-foreground">
          {telemetryStatus === "offline" ? (
            <span className="max-w-[85%] text-center text-muted-foreground">
              {t("stageCameraOffline")}
            </span>
          ) : telemetryStatus === "encrypted" || telemetryStatus === "error" || errorMsg ? (
            <span className="max-w-[85%] text-center text-destructive-foreground">
              {errorMsg || lastError || t("stageStreamUnavailable")}
            </span>
          ) : (
            <>
              <Spinner className="size-4" />
              <span>{t("stageConnecting")}</span>
            </>
          )}
        </div>
      )}
    </>
  );
}

function MseFmp4Stage({
  deviceId,
  rotate180,
  panOffset,
  isMirrorLeader = false,
}: {
  deviceId: string;
  rotate180: boolean;
  panOffset?: { x: number; y: number };
  isMirrorLeader?: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return registerLiveMirrorSource(deviceId, video, !isMirrorLeader);
  }, [deviceId, isMirrorLeader]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let ms: MediaSource | null = null;
    let sb: SourceBuffer | null = null;
    let queue: Uint8Array[] = [];
    let currentUrl = "";
    let resetPending = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanupMs = () => {
      queue = [];
      sb = null;
      resetPending = false;
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
        currentUrl = "";
      }
      if (ms && ms.readyState === "open") {
        try {
          ms.endOfStream();
        } catch {
          // ignore
        }
      }
      ms = null;
    };

    const flush = () => {
      if (!sb || sb.updating) return;
      if (resetPending) {
        resetPending = false;
        queue = [];
        try {
          if (sb.buffered.length > 0) {
            sb.remove(0, Infinity);
            return;
          }
        } catch {
          // ignore
        }
      }
      const next = queue.shift();
      if (!next) return;
      try {
        sb.appendBuffer(new Uint8Array(next).buffer);
      } catch {
        queue = [];
      }
    };

    const trimBuffer = () => {
      if (!sb || sb.updating || sb.buffered.length === 0) return;
      const start = sb.buffered.start(0);
      const end = sb.buffered.end(sb.buffered.length - 1);
      if (end - video.currentTime > 2.2) {
        video.currentTime = end - 0.15;
      }
      if (video.currentTime - start > 15) {
        try {
          sb.remove(start, video.currentTime - 6);
        } catch {
          // ignore
        }
      }
    };

    const initMediaSource = (mime: string, initBytes: Uint8Array) => {
      cleanupMs();
      if (!("MediaSource" in window) || !MediaSource.isTypeSupported(mime)) {
        setErrorMsg(tRef.current("stageMseUnsupported"));
        return;
      }
      ms = new MediaSource();
      currentUrl = URL.createObjectURL(ms);
      video.src = currentUrl;
      ms.addEventListener(
        "sourceopen",
        () => {
          if (cancelled || !ms) return;
          try {
            sb = ms.addSourceBuffer(mime);
            sb.mode = "segments";
            sb.addEventListener("updateend", () => {
              trimBuffer();
              flush();
            });
            queue.push(initBytes);
            flush();
            setConnecting(false);
            setErrorMsg(null);
            void video.play().catch(() => {});
          } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : tRef.current("stageMseError"));
          }
        },
        { once: true },
      );
    };

    const connect = () => {
      if (cancelled) return;
      setConnecting(true);
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws/fmp4/${encodeURIComponent(deviceId)}`);
      ws.binaryType = "arraybuffer";

      ws.onmessage = (ev) => {
        if (cancelled || !(ev.data instanceof ArrayBuffer)) return;
        const buf = new Uint8Array(ev.data);
        const type = buf[0];
        if (type === 0x01) {
          const mimeLen = buf[1] ?? 0;
          const mime = new TextDecoder().decode(buf.subarray(2, 2 + mimeLen));
          initMediaSource(mime, buf.subarray(2 + mimeLen));
        } else if (type === 0x02) {
          if (queue.length > 45) queue = queue.slice(-4);
          queue.push(buf.subarray(1));
          flush();
          if (video.paused && sb && sb.buffered.length > 0) {
            void video.play().catch(() => {});
          }
        } else if (type === 0x03) {
          resetPending = true;
          flush();
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 2200);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
      cleanupMs();
    };
  }, [deviceId]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="block h-full w-full object-contain"
        style={mediaRotationStyle(rotate180, panOffset)}
      />
      {(connecting || errorMsg) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950/70 text-xs text-muted-foreground">
          {errorMsg ? (
            <span className="text-destructive-foreground">{errorMsg}</span>
          ) : (
            <>
              <Spinner className="size-4" />
              <span>{t("stageHdStream")}</span>
            </>
          )}
        </div>
      )}
    </>
  );
}

function MjpegStage({
  deviceId,
  rotate180,
  panOffset,
  isMirrorLeader = false,
  telemetryStatus,
  lastError,
}: {
  deviceId: string;
  rotate180: boolean;
  panOffset?: { x: number; y: number };
  isMirrorLeader?: boolean;
  telemetryStatus?: RelayStatus;
  lastError?: string | null;
}): React.ReactElement {
  const { t } = useI18n();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    return registerLiveMirrorSource(deviceId, img, !isMirrorLeader);
  }, [deviceId, isMirrorLeader]);

  return (
    <>
      <img
        alt=""
        className="block h-full w-full object-contain"
        decoding="async"
        onError={() => {
          setLoaded(false);
          setTimeout(() => setNonce((n) => n + 1), 2500);
        }}
        onLoad={() => setLoaded(true)}
        ref={imgRef}
        src={`/api/stream/${encodeURIComponent(deviceId)}/mjpeg?v=${nonce}`}
        style={mediaRotationStyle(rotate180, panOffset)}
      />
      {!loaded && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950/70 text-xs text-muted-foreground">
          {telemetryStatus === "offline" ? (
            <span className="max-w-[85%] text-center text-muted-foreground">
              {t("stageCameraOffline")}
            </span>
          ) : telemetryStatus === "error" || telemetryStatus === "encrypted" ? (
            <span className="max-w-[85%] text-center text-destructive-foreground">
              {lastError || t("stageStreamError")}
            </span>
          ) : (
            <>
              <Spinner className="size-4" />
              <span>{t("stageConnecting")}</span>
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Mirrors an active real camera's live frames into an emulated camera tile with zero extra
 * decoders when the real camera is mounted. If the real camera is not currently mounted (e.g.
 * filtered to a simulated store or opened in Focus view), one simulated tile automatically acts
 * as the mirror leader and streams the real camera once for all mirrored tiles.
 */
function MirroredStreamStage({
  sourceDeviceId,
  quality,
  transport,
  targetFps,
  rotate180,
  panOffset,
  telemetryStatus,
  lastError,
}: {
  sourceDeviceId: string;
  quality: "grid" | "hd";
  transport: GridTransport;
  targetFps: number;
  rotate180: boolean;
  panOffset?: { x: number; y: number };
  telemetryStatus?: RelayStatus;
  lastError?: string | null;
}): React.ReactElement {
  const { t } = useI18n();
  const tokenRef = useRef<symbol>(Symbol("mirror-stage"));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isLeader, setIsLeader] = useState(false);
  const [fallbackActive, setFallbackActive] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    setFallbackActive(false);
  }, [sourceDeviceId, quality, transport]);

  useEffect(() => {
    const token = tokenRef.current;
    const evaluate = () => {
      setIsLeader(acquireMirrorLeader(sourceDeviceId, token));
    };
    evaluate();
    const unsub = subscribeLiveMirrorChange(evaluate);
    return () => {
      unsub();
      releaseMirrorLeader(sourceDeviceId, token);
    };
  }, [sourceDeviceId]);

  useEffect(() => {
    if (isLeader) return;
    setHasFrame(false);
    let cancelled = false;
    let rafId = 0;
    let lastDrawAt = -Infinity;

    const tick = (now: number) => {
      if (cancelled) return;
      rafId = requestAnimationFrame(tick);
      const minInterval = targetFps >= 30 ? 30 : 1000 / Math.max(0.5, targetFps);
      if (now - lastDrawAt < minInterval) return;

      const src = getLiveMirrorSource(sourceDeviceId);
      const canvas = canvasRef.current;
      if (!src || !canvas || !isLiveMirrorElementReady(src)) return;

      const { width, height } = getLiveMirrorElementSize(src);
      if (width <= 0 || height <= 0) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
      if (!ctx) return;
      try {
        ctx.drawImage(src, 0, 0, width, height);
        lastDrawAt = now;
        setHasFrame((prev) => (prev ? prev : true));
      } catch {
        // source may be transitioning
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [isLeader, sourceDeviceId, targetFps]);

  if (isLeader) {
    const useWebCodecs = canUseWebCodecs() && transport === "webcodecs" && !fallbackActive;
    if (useWebCodecs) {
      return (
        <MediabunnyTsStage
          deviceId={sourceDeviceId}
          isMirrorLeader
          keyframeOnly={quality === "grid" && targetFps <= 1}
          lastError={lastError}
          onFallback={() => setFallbackActive(true)}
          panOffset={panOffset}
          quality={quality}
          rotate180={rotate180}
          targetFps={quality === "hd" ? 60 : targetFps}
          telemetryStatus={telemetryStatus}
        />
      );
    }
    if (quality === "hd") {
      return (
        <MseFmp4Stage
          deviceId={sourceDeviceId}
          isMirrorLeader
          panOffset={panOffset}
          rotate180={rotate180}
        />
      );
    }
    return (
      <MjpegStage
        deviceId={sourceDeviceId}
        isMirrorLeader
        lastError={lastError}
        panOffset={panOffset}
        rotate180={rotate180}
        telemetryStatus={telemetryStatus}
      />
    );
  }

  return (
    <>
      <canvas
        className="block h-full w-full object-contain"
        ref={canvasRef}
        style={mediaRotationStyle(rotate180, panOffset)}
      />
      {!hasFrame && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950/70 text-xs text-muted-foreground">
          <Spinner className="size-4" />
          <span>{t("stageConnecting")}</span>
        </div>
      )}
    </>
  );
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function SimulatedStreamStage({
  deviceId,
  quality,
  targetFps,
  panOffset,
  rotate180,
}: {
  deviceId: string;
  quality: "grid" | "hd";
  targetFps: number;
  panOffset?: { x: number; y: number };
  rotate180: boolean;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fpsRef = useRef(targetFps);
  const panRef = useRef(panOffset ?? { x: 0, y: 0 });
  fpsRef.current = targetFps;
  panRef.current = panOffset ?? { x: 0, y: 0 };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = quality === "hd" ? 1280 : 640;
    const h = quality === "hd" ? 720 : 360;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) return;

    const seed = hashSeed(deviceId);
    const hue = (seed % 5) * 44 + 175;
    let visible = true;
    let rafId = 0;
    let lastDraw = 0;

    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            visible = entries.some((e) => e.isIntersecting);
          })
        : null;
    io?.observe(canvas);

    const renderFrame = (ts: number) => {
      rafId = requestAnimationFrame(renderFrame);
      if (!visible) return;
      const effectiveFps = Math.min(fpsRef.current >= 30 ? 15 : fpsRef.current, 24);
      const minGap = 1000 / Math.max(0.2, effectiveFps);
      if (ts - lastDraw < minGap) return;
      lastDraw = ts;

      const t = ts * 0.001 + (seed % 100);
      const px = (panRef.current.x ?? 0) * 1.6;
      const py = -(panRef.current.y ?? 0) * 1.6;

      // Dark indoor/outdoor CCTV backdrop gradient
      const bg = ctx.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, `hsl(${hue}, 18%, 11%)`);
      bg.addColorStop(0.55, `hsl(${(hue + 24) % 360}, 14%, 7%)`);
      bg.addColorStop(1, "#07090b");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Perspective floor grid shifted by simulated PTZ pan/tilt
      ctx.save();
      ctx.translate(px, py);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
      ctx.lineWidth = 1;
      const horizonY = h * 0.44;
      const vanishX = w * 0.5;
      for (let i = -8; i <= 8; i++) {
        ctx.beginPath();
        ctx.moveTo(vanishX + i * 24, horizonY);
        ctx.lineTo(vanishX + i * 110, h + 60);
        ctx.stroke();
      }
      for (let row = 0; row <= 6; row++) {
        const y = horizonY + ((row * row) / 36) * (h - horizonY + 40);
        ctx.beginPath();
        ctx.moveTo(-120, y);
        ctx.lineTo(w + 120, y);
        ctx.stroke();
      }

      // Soft sweeping ambient beam + simulated moving person/object marker
      const sweepX = w * (0.5 + 0.32 * Math.sin(t * 0.55));
      const cone = ctx.createRadialGradient(sweepX, h * 0.62, 6, sweepX, h * 0.62, w * 0.22);
      cone.addColorStop(0, `hsla(${hue}, 80%, 62%, 0.16)`);
      cone.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = cone;
      ctx.fillRect(-100, -100, w + 200, h + 200);

      const bx = w * (0.28 + 0.44 * (0.5 + 0.5 * Math.sin(t * 0.42 + (seed % 7))));
      const by = h * 0.52;
      const bw = w * 0.085;
      const bh = h * 0.24;
      ctx.strokeStyle = "rgba(52, 211, 153, 0.65)";
      ctx.lineWidth = quality === "hd" ? 2 : 1.5;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = "rgba(16, 185, 129, 0.22)";
      ctx.fillRect(bx, by - 16, 62, 16);
      ctx.fillStyle = "#a7f3d0";
      ctx.font = quality === "hd" ? "600 12px monospace" : "600 10px monospace";
      ctx.fillText(`SIM ${quality === "hd" ? "HD" : "VGA"}`, bx + 4, by - 4);
      ctx.restore();

      // Classic Tapo-style timestamp OSD
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
      ctx.fillRect(10, h - 28, 178, 20);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.font = quality === "hd" ? "13px monospace" : "11px monospace";
      ctx.fillText(stamp, 16, h - 14);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => {
      cancelAnimationFrame(rafId);
      io?.disconnect();
    };
  }, [deviceId, quality]);

  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full object-contain"
      style={mediaRotationStyle(rotate180)}
    />
  );
}
