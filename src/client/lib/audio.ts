import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";

// Precompute G.711 u-law -> Float32 PCM table for zero-overhead browser decoding.
const ULAW_TABLE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let sample = ((mant << 3) + 0x84) << exp;
  sample -= 0x84;
  ULAW_TABLE[i] = (sign ? -sample : sample) / 32768;
}

/** Encode signed 16-bit PCM sample (-32768..32767) into 8-bit G.711 A-law. */
export function linearToAlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, sample | 0));
  let mask = 0xd5;
  if (pcm < 0) {
    pcm = -pcm - 1;
    mask = 0x55;
  }
  if (pcm > 32767) pcm = 32767;
  let seg = 0;
  let val = pcm >> 4;
  if (val >= 0x20) {
    seg = 1;
    while (val >= 0x40 && seg < 7) {
      val >>= 1;
      seg += 1;
    }
  }
  const mant = seg === 0 ? (pcm >> 4) & 0x0f : (pcm >> (seg + 3)) & 0x0f;
  return ((seg << 4) | mant) ^ mask;
}

export function encodeFloat32ToAlaw8k(input: Float32Array, inputRate: number): Uint8Array {
  const ratio = inputRate / 8000;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.min(input.length - 1, Math.floor(pos));
    const nextIdx = Math.min(input.length - 1, idx + 1);
    const frac = pos - idx;
    const sample = input[idx]! * (1 - frac) + input[nextIdx]! * frac;
    out[i] = linearToAlaw(Math.round(sample * 32767));
  }
  return out;
}

export function useCameraAudio(deviceId: string, online: boolean): {
  listening: boolean;
  connecting: boolean;
  level: number;
  gain: number;
  setGain: (nextGain: number) => void;
  toggle: () => void;
  stop: () => void;
} {
  const [listening, setListening] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [level, setLevel] = useState(0);
  const [gain, setGainState] = useState(2.0);

  const ctxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nextAtRef = useRef(0);
  const gainRef = useRef(gain);
  gainRef.current = gain;

  const stop = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    gainNodeRef.current = null;
    nextAtRef.current = 0;
    setListening(false);
    setConnecting(false);
    setLevel(0);
  }, []);

  useEffect(() => {
    return () => stop();
  }, [deviceId, stop]);

  useEffect(() => {
    if (!online && listening) stop();
  }, [online, listening, stop]);

  const setGain = useCallback((nextGain: number) => {
    const clamped = Math.max(0.5, Math.min(5, nextGain));
    setGainState(clamped);
    gainRef.current = clamped;
    if (gainNodeRef.current && ctxRef.current) {
      gainNodeRef.current.gain.setValueAtTime(clamped, ctxRef.current.currentTime);
    }
  }, []);

  const toggle = useCallback(() => {
    if (listening || connecting) {
      stop();
      return;
    }
    if (!online) return;

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx({ sampleRate: 16000 });
    void ctx.resume().catch(() => {});

    const gainNode = ctx.createGain();
    gainNode.gain.value = gainRef.current;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;

    gainNode.connect(limiter);
    limiter.connect(ctx.destination);

    ctxRef.current = ctx;
    gainNodeRef.current = gainNode;
    nextAtRef.current = ctx.currentTime + 0.06;
    setConnecting(true);
    setListening(true);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/audio/${encodeURIComponent(deviceId)}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer) || ctxRef.current !== ctx) return;
      const ulaw = new Uint8Array(ev.data);
      if (ulaw.length === 0) return;

      setConnecting(false);
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }

      const pcm = new Float32Array(ulaw.length);
      let sumSq = 0;
      for (let i = 0; i < ulaw.length; i++) {
        const s = ULAW_TABLE[ulaw[i]!]!;
        pcm[i] = s;
        sumSq += s * s;
      }
      const rms = Math.min(1, Math.sqrt(sumSq / ulaw.length) * gainRef.current * 2.5);
      setLevel(rms);

      const buf = ctx.createBuffer(1, pcm.length, 16000);
      buf.copyToChannel(pcm, 0);

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gainNode);

      const now = ctx.currentTime;
      if (nextAtRef.current < now + 0.015 || nextAtRef.current > now + 0.5) {
        nextAtRef.current = now + 0.05;
      }
      src.start(nextAtRef.current);
      nextAtRef.current += buf.duration;
    };

    ws.onerror = () => {
      setConnecting(false);
    };
    ws.onclose = () => {
      if (wsRef.current === ws) {
        stop();
      }
    };
  }, [connecting, deviceId, listening, online, stop]);

  return { listening, connecting, level, gain, setGain, toggle, stop };
}

export type TalkState = "idle" | "connecting" | "live" | "error";

export function useCameraTalk(deviceId: string, online: boolean): {
  state: TalkState;
  micLevel: number;
  error: string | null;
  toggle: () => void;
  stop: () => void;
} {
  const { t } = useI18n();
  const [state, setState] = useState<TalkState>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const readyRef = useRef(false);

  const stop = useCallback(() => {
    readyRef.current = false;
    try {
      procRef.current?.disconnect();
    } catch {
      // ignore
    }
    procRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
    setMicLevel(0);
    setState("idle");
  }, []);

  useEffect(() => {
    return () => stop();
  }, [deviceId, stop]);

  useEffect(() => {
    if (!online && state !== "idle") stop();
  }, [online, state, stop]);

  const start = useCallback(async () => {
    if (!online) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      const insecure = typeof window !== "undefined" && !window.isSecureContext;
      setError(t(insecure ? "audioMicRequiresHttps" : "audioMicUnavailableOrigin"));
      setState("error");
      return;
    }

    setError(null);
    setState("connecting");

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = mediaStream;

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      void ctx.resume().catch(() => {});
      ctxRef.current = ctx;

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/talk/${encodeURIComponent(deviceId)}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data) as { type?: string; message?: string };
          if (msg.type === "ready") {
            readyRef.current = true;
            setState("live");
          } else if (msg.type === "error") {
            setError(msg.message || t("audioTalkError"));
            setState("error");
            stop();
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        setError(t("audioTalkChannelFailed"));
        stop();
        setState("error");
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          stop();
        }
      };

      const source = ctx.createMediaStreamSource(mediaStream);
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      const silencer = ctx.createGain();
      silencer.gain.value = 0;

      let alawRemainder = new Uint8Array(0);
      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < input.length; i++) sumSq += input[i]! * input[i]!;
        setMicLevel(Math.min(1, Math.sqrt(sumSq / input.length) * 3));

        if (!readyRef.current || ws.readyState !== WebSocket.OPEN) return;
        const encoded = encodeFloat32ToAlaw8k(input, ctx.sampleRate);
        const combined = new Uint8Array(alawRemainder.length + encoded.length);
        combined.set(alawRemainder, 0);
        combined.set(encoded, alawRemainder.length);

        const FRAME_BYTES = 320; // 40ms @ 8 kHz
        let offset = 0;
        while (offset + FRAME_BYTES <= combined.length) {
          ws.send(combined.subarray(offset, offset + FRAME_BYTES));
          offset += FRAME_BYTES;
        }
        alawRemainder = combined.subarray(offset);
      };

      source.connect(processor);
      processor.connect(silencer);
      silencer.connect(ctx.destination);
      procRef.current = processor;
    } catch (err) {
      stop();
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? t("audioMicPermissionDenied")
          : err instanceof Error
            ? err.message
            : t("audioMicUnavailable"),
      );
      setState("error");
    }
  }, [deviceId, online, stop, t]);

  const toggle = useCallback(() => {
    if (state === "connecting" || state === "live") {
      stop();
    } else {
      void start();
    }
  }, [start, state, stop]);

  return { state, micLevel, error, toggle, stop };
}
