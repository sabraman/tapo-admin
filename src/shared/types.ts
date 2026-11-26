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

export interface CameraOrientation {
  rotate180?: boolean;
  invertPtz?: boolean;
}

export interface CameraMeta {
  deviceId: string;
  alias: string;
  customName?: string;
  cloudNickname?: string;
  familyId?: string;
  roomId?: string;
  orientation?: CameraOrientation;
  /** Debug emulator only: real camera deviceId whose live video stream is mirrored. */
  mirrorSourceDeviceId?: string;
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

export interface SdCardDetails {
  status: string;
  totalSpace?: string;
  freeSpace?: string;
  percent?: number;
  rwAttr?: string;
  loopRecordEnabled?: boolean;
}

export interface CameraPreset {
  id: string;
  name: string;
}

export interface CameraCapabilitySnapshot {
  deviceId: string;
  online: boolean;
  privacyOn: boolean | null;
  ptzSupported: boolean;
  sdStatus: "ready" | "missing_or_unformatted" | "unknown";
  sdErrorCode?: number;
  sdCard?: SdCardDetails;
  cameraTime?: string;
  resolutions?: string[];
  encodeTypes?: string[];
  micVolume?: number;
  micMuted?: boolean;
  speakerVolume?: number;
  alarmEnabled?: boolean;
  presets?: CameraPreset[];
  lastCheckedAt: number;
  error?: string;
}

export type DetectionEventKind =
  | "motion"
  | "person"
  | "tamper"
  | "baby_cry"
  | "line_crossing"
  | "intrusion"
  | "vehicle"
  | "pet"
  | "sound"
  | "continuous"
  | "event"
  | "unknown";

export interface RecordingClip {
  start: number;
  end: number;
  duration: number;
  type: number;
  startLocal: string;
  endLocal: string;
  source?: "event" | "segment";
  eventKinds?: DetectionEventKind[];
  alarmType?: number;
  eventsBitmask?: number;
}

export interface RecordingDayResponse {
  date: string;
  timezone: string;
  clips: RecordingClip[];
  eventsCount?: number;
  segmentsCount?: number;
}

export type RecordPlanDayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface RecordPlanSegment {
  start: string;
  end: string;
  mode: 1 | 2;
}

export interface CameraRecordPlan {
  supported: boolean;
  enabled: boolean;
  days: Record<RecordPlanDayKey, RecordPlanSegment[]>;
}

export type DetectionSensitivity = "low" | "normal" | "high";
export type DayNightMode = "auto" | "on" | "off";
export type AlarmVolume = "low" | "normal" | "high";
export type RebootScheduleDay =
  | "everyday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface CameraAlarmConfig {
  supported: boolean;
  enabled: boolean;
  alarmMode: string[];
  alarmType: string;
  alarmVolume: AlarmVolume;
  alarmDuration: number;
  sirenTypes: string[];
  sirenStatus?: "on" | "off";
}

export interface CameraRebootSchedule {
  supported: boolean;
  enabled: boolean;
  time: string;
  day: RebootScheduleDay;
  randomRange?: number;
}

export interface CameraSettingsSnapshot {
  deviceId: string;
  online: boolean;
  speakerVolume?: number;
  micVolume?: number;
  micMuted?: boolean;
  sdCard?: SdCardDetails;
  alarm: CameraAlarmConfig;
  rebootSchedule: CameraRebootSchedule;
  recordPlan: CameraRecordPlan;
  dayNightMode?: DayNightMode;
  imageFlip?: boolean;
  ledEnabled?: boolean;
  autoTracking?: boolean;
  motionDetection?: {
    supported: boolean;
    enabled: boolean;
    sensitivity: DetectionSensitivity;
  };
  personDetection?: {
    supported: boolean;
    enabled: boolean;
    sensitivity: DetectionSensitivity;
  };
  presets: CameraPreset[];
  lastCheckedAt: number;
}

export interface CameraSettingsPatch {
  speakerVolume?: number;
  micVolume?: number;
  micMuted?: boolean;
  alarm?: {
    enabled?: boolean;
    alarmMode?: string[];
    alarmType?: string;
    alarmVolume?: AlarmVolume;
    alarmDuration?: number;
  };
  rebootSchedule?: {
    enabled: boolean;
    time: string;
    day: RebootScheduleDay;
  };
  recordPlan?: {
    enabled: boolean;
    days: Record<RecordPlanDayKey, RecordPlanSegment[]>;
  };
  dayNightMode?: DayNightMode;
  imageFlip?: boolean;
  ledEnabled?: boolean;
  autoTracking?: boolean;
  motionDetection?: {
    enabled?: boolean;
    sensitivity?: DetectionSensitivity;
  };
  personDetection?: {
    enabled?: boolean;
    sensitivity?: DetectionSensitivity;
  };
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

export type FfmpegInstallPhase = "idle" | "downloading" | "verifying" | "ready" | "error";

export interface FfmpegInstallState {
  phase: FfmpegInstallPhase;
  available: boolean;
  supported: boolean;
  binaryPath?: string;
  progress?: number;
  bytesReceived?: number;
  bytesTotal?: number;
  error?: string;
}

export interface RuntimeCapabilities {
  ffmpegAvailable: boolean;
  ffmpegInstall?: FfmpegInstallState;
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
