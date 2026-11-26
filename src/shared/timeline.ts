import type { DetectionEventKind, RecordingClip } from "./types";

export interface TimelineDropResolution {
  clip: RecordingClip;
  seekStartSec: number;
  skippedGap: boolean;
}

export function getClipPrimaryKind(clip: RecordingClip): DetectionEventKind {
  if (clip.eventKinds && clip.eventKinds.length > 0) {
    if (clip.eventKinds.includes("person")) return "person";
    if (clip.eventKinds.includes("tamper")) return "tamper";
    if (clip.eventKinds.includes("intrusion")) return "intrusion";
    return clip.eventKinds[0]!;
  }
  if (clip.type === 1) return "continuous";
  if (clip.type === 6) return "person";
  if (clip.type === 3) return "tamper";
  if (clip.type === 2) return "motion";
  return clip.source === "event" ? "event" : "unknown";
}

/**
 * Resolves a click/scrub timestamp on the 24-hour SD timeline to a playback clip & start time.
 * Matches Tapo app behavior: dropping inside a clip plays from that offset; dropping in a grey
 * empty gap automatically advances to the next chronological clip (or snaps to the last clip).
 */
export function resolveTimelineDropTarget(
  targetSec: number,
  clips: readonly RecordingClip[],
): TimelineDropResolution | null {
  if (clips.length === 0) return null;
  const sorted = [...clips].sort((a, b) => a.start - b.start || a.end - b.end);

  // Prefer richly-typed event clips (especially person detections) over continuous segments.
  const overlapping = sorted.filter((c) => c.start <= targetSec && targetSec < c.end);
  if (overlapping.length > 0) {
    const preferred =
      overlapping.find((c) => getClipPrimaryKind(c) === "person") ??
      overlapping.find((c) => c.source === "event") ??
      overlapping[0]!;
    const offset = Math.floor(targetSec - preferred.start);
    const seekStartSec =
      offset <= 3
        ? preferred.start
        : Math.min(Math.floor(targetSec), Math.max(preferred.start, preferred.end - 3));
    return { clip: preferred, seekStartSec, skippedGap: false };
  }

  // Grey gap: jump forward to the next chronological clip after targetSec.
  const nextClip = sorted.find((c) => c.start > targetSec);
  if (nextClip) {
    return { clip: nextClip, seekStartSec: nextClip.start, skippedGap: true };
  }

  // Clicked past the last recording of the day: snap to the last clip.
  const lastClip = sorted[sorted.length - 1]!;
  return { clip: lastClip, seekStartSec: lastClip.start, skippedGap: true };
}
