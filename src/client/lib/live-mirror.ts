export type LiveMirrorElement = HTMLCanvasElement | HTMLVideoElement | HTMLImageElement;

interface RegisteredSource {
  el: LiveMirrorElement;
  isPrimary: boolean;
}

const sourcesByDevice = new Map<string, Set<RegisteredSource>>();
const leadersByDevice = new Map<string, symbol>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  }
}

export function isLiveMirrorElementReady(el: LiveMirrorElement): boolean {
  if (el instanceof HTMLCanvasElement) {
    return el.width > 0 && el.height > 0;
  }
  if (el instanceof HTMLVideoElement) {
    return el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0;
  }
  return el.complete && el.naturalWidth > 0 && el.naturalHeight > 0;
}

export function getLiveMirrorElementSize(el: LiveMirrorElement): { width: number; height: number } {
  if (el instanceof HTMLCanvasElement) {
    return { width: el.width, height: el.height };
  }
  if (el instanceof HTMLVideoElement) {
    return { width: el.videoWidth, height: el.videoHeight };
  }
  return { width: el.naturalWidth, height: el.naturalHeight };
}

export function registerLiveMirrorSource(
  deviceId: string,
  el: LiveMirrorElement,
  isPrimary = true,
): () => void {
  let set = sourcesByDevice.get(deviceId);
  if (!set) {
    set = new Set();
    sourcesByDevice.set(deviceId, set);
  }
  const entry: RegisteredSource = { el, isPrimary };
  set.add(entry);
  if (isPrimary && leadersByDevice.has(deviceId)) {
    leadersByDevice.delete(deviceId);
  }
  notify();

  return () => {
    const current = sourcesByDevice.get(deviceId);
    if (current) {
      current.delete(entry);
      if (current.size === 0) {
        sourcesByDevice.delete(deviceId);
      }
    }
    notify();
  };
}

export function getLiveMirrorSource(deviceId: string): LiveMirrorElement | null {
  const set = sourcesByDevice.get(deviceId);
  if (!set || set.size === 0) return null;
  let fallback: LiveMirrorElement | null = null;
  for (const entry of set) {
    if (entry.isPrimary && isLiveMirrorElementReady(entry.el)) return entry.el;
    if (!fallback && isLiveMirrorElementReady(entry.el)) fallback = entry.el;
  }
  if (fallback) return fallback;
  for (const entry of set) {
    if (entry.isPrimary) return entry.el;
    fallback ??= entry.el;
  }
  return fallback;
}

export function hasPrimaryLiveMirrorSource(deviceId: string): boolean {
  const set = sourcesByDevice.get(deviceId);
  if (!set) return false;
  for (const entry of set) {
    if (entry.isPrimary) return true;
  }
  return false;
}

export function acquireMirrorLeader(deviceId: string, token: symbol): boolean {
  if (hasPrimaryLiveMirrorSource(deviceId)) {
    if (leadersByDevice.get(deviceId) === token) {
      leadersByDevice.delete(deviceId);
    }
    return false;
  }
  const current = leadersByDevice.get(deviceId);
  if (!current || current === token) {
    leadersByDevice.set(deviceId, token);
    return true;
  }
  return false;
}

export function releaseMirrorLeader(deviceId: string, token: symbol): void {
  if (leadersByDevice.get(deviceId) === token) {
    leadersByDevice.delete(deviceId);
    notify();
  }
}

export function subscribeLiveMirrorChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
