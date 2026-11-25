export type AuthState =
  | { status: "unauthenticated" }
  | {
      status: "mfa_required";
      baseUrl: string;
      email: string;
      terminalUuid: string;
      mfaProcessId: string;
      supportedMFATypes: number[];
      sentMfaType?: number;
    }
  | {
      status: "authenticated";
      email: string;
      baseUrl: string;
      regionCode: string;
      terminalBound: boolean;
      savedAt: number;
    };

export type NetworkKind = "wired" | "4g-modem";

export interface Store {
  id: string;
  name: string;
  address: string;
  networkKind: NetworkKind;
  cameraIds: string[];
  createdAt: number;
  familyId?: string;
  roomId?: string;
  source?: "cloud" | "local";
}

export interface CameraMeta {
  deviceId: string;
  alias: string;
  customName?: string;
  cloudNickname?: string;
  familyId?: string;
  roomId?: string;
  deviceModel: string;
  deviceName: string;
  deviceHwVer: string;
  fwVer: string;
  deviceRegion: string;
  mac?: string;
  accessPlatform: string;
  appServerUrl: string;
  deviceType: string;
  rawStatus: number;
}

export type StreamQuality = "VGA" | "HD";
export type StreamMode = "off" | "grid_low" | "focus_hd";
export type RelayStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "offline"
  | "encrypted"
  | "error";

export interface CameraTelemetry {
  deviceId: string;
  status: RelayStatus;
  mode: StreamMode;
  resolution: StreamQuality;
  gridFps: number;
  subscribers: number;
  audioSubscribers: number;
  kbps: number;
  bytesTotal: number;
  connectLatencyMs: number | null;
  lastFrameAt: number | null;
  reconnects: number;
  lastError: string | null;
}

export interface CameraCapabilitySnapshot {
  deviceId: string;
  online: boolean;
  privacyOn: boolean | null;
  ptzSupported: boolean;
  sdStatus: "ready" | "missing_or_unformatted" | "unknown";
  sdErrorCode?: number;
  cameraTime?: string;
  resolutions?: string[];
  encodeTypes?: string[];
  micVolume?: number;
  micMuted?: boolean;
  speakerVolume?: number;
  lastCheckedAt: number;
  error?: string;
}

export interface RecordingClip {
  start: number;
  end: number;
  duration: number;
  type: number;
  startLocal: string;
  endLocal: string;
}

export interface RecordingDayResponse {
  date: string;
  timezone: string;
  clips: RecordingClip[];
}

export interface RelayEventLog {
  id: string;
  ts: number;
  level: "info" | "warn" | "error";
  deviceId?: string;
  message: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
}

export type GridFps = 0.5 | 1 | 2 | 3 | 5 | 10 | 30;
export type GridTransport = "webcodecs" | "mjpeg";
export type LanguagePreference = "auto" | "en" | "ru";
export type ResolvedLanguage = "en" | "ru";

export interface DashboardSettings {
  gridFps: GridFps;
  gridResolution: StreamQuality;
  gridTransport: GridTransport;
  autoCycleSeconds: 0 | 15 | 30 | 60;
  language: LanguagePreference;
}

export interface MediaItem {
  id: string;
  kind: "snapshot" | "clip";
  deviceId: string;
  cameraName: string;
  storeName?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
  createdAt: number;
}

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "applying"
  | "error";

export interface AppUpdateState {
  currentVersion: string;
  phase: AppUpdatePhase;
  canAutoUpdate: boolean;
  latestVersion?: string;
  releaseUrl: string;
  message?: string;
  progress?: number;
  checkedAt?: number;
  error?: string;
}

export interface RuntimeCapabilities {
  ffmpegAvailable: boolean;
  debugEmulatorEnabled: boolean;
  desktopApp: boolean;
  appVersion: string;
}

export interface DashboardBootstrap {
  accessRequired: boolean;
  accessUnlocked: boolean;
  auth: AuthState;
  cameras: CameraMeta[];
  stores: Store[];
  telemetry: Record<string, CameraTelemetry>;
  settings: DashboardSettings;
  logs: RelayEventLog[];
  media: MediaItem[];
  mediaDir: string;
  capabilities: RuntimeCapabilities;
  updateState: AppUpdateState;
}
