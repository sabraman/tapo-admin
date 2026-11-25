import type React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  formatMessageTemplate,
  normalizeLanguagePreference,
  resolveLanguage,
  SERVER_MESSAGES,
  tServer,
  type ServerMessageKey,
} from "../../shared/i18n";
import type {
  LanguagePreference,
  RelayEventLog,
  RelayStatus,
  ResolvedLanguage,
} from "../../shared/types";

const LANGUAGE_STORAGE_KEY = "tapo-admin:language:v1";

const EN_MESSAGES = {
  appName: "Tapo Admin",
  loadingDashboard: "Loading dashboard...",
  cancel: "Cancel",
  save: "Save",
  create: "Create",
  close: "Close",
  delete: "Delete",
  edit: "Edit",
  back: "Back",
  reset: "Reset",
  applySettings: "Apply settings",
  download: "Download",
  online: "Online",
  offline: "Offline",
  error: "Error",
  connecting: "Connecting",
  idle: "Idle",
  encrypted: "Encrypted",
  auto: "Auto",
  languageLabel: "Language",
  languageAuto: "Auto (System)",
  languageEn: "English",
  languageRu: "Русский",

  accessGateBadge: "Protected Access",
  accessGateDescription: "Enter the dashboard password to unlock access.",
  accessGatePasswordLabel: "Access password",
  accessGatePasswordPlaceholder: "Enter password",
  accessGatePasswordHint: "Configured via TAPO_ACCESS_PASSWORD on the server.",
  accessGateSubmit: "Unlock",
  accessGateErrorTitle: "Access denied",
  accessGateErrorFallback: "Failed to unlock dashboard",

  authBadge: "Cloud Monitor",
  authMfaDescription: "Verify sign-in for {email}",
  authLoginDescription: "Connect your TP-Link Tapo account to manage cameras across all locations.",
  authErrorTitle: "Sign-in failed",
  authLoginErrorFallback: "Authentication error",
  authMfaSendErrorFallback: "Failed to send verification code",
  authMfaVerifyErrorFallback: "Invalid verification code",
  authSendEmailCode: "Send code to email",
  authSendSmsCode: "Send SMS",
  authMfaCodeLabel: "Verification code (2FA)",
  authMfaCodePlaceholder: "6-digit code",
  authMfaCodeHint: "This terminal will be bound locally so you won't need to enter the code again.",
  authConfirmSignIn: "Confirm sign-in",
  authEmailLabel: "Tapo account email",
  authEmailPlaceholder: "owner@example.com",
  authPasswordLabel: "Password",
  authPasswordHint: "Your password is only used to obtain a session token and is never written to disk.",
  authSignInButton: "Sign in to Tapo Cloud",

  headerStatusAria: "Status and location filter",
  headerOnlineCountTitle: "Cameras online: {online} of {total}",
  filterAll: "All",
  filterAllStores: "All locations",
  filterUnassigned: "Unassigned",
  moreStoresAria: "More locations: {count}",
  createStoreAria: "Create location",
  createStoreTooltip: "Create location",
  searchCameraAria: "Search cameras",
  searchCameraPlaceholder: "Search cameras...",
  gridLayoutAria: "Grid density",
  gridLayoutAuto: "Auto",
  galleryAria: "Snapshots and clips gallery",
  galleryLabel: "Gallery",
  galleryTooltip: "Saved snapshots and video clips",
  systemAria: "Settings, locations, and diagnostics",
  systemLabel: "System",
  systemTooltip: "Stream settings, locations, diagnostics",
  emptyNoCamerasTitle: "No cameras in account",
  emptyNoFilteredTitle: "No cameras match this filter",
  emptyNoCamerasDesc: "Sync your device list from Tapo Cloud.",
  emptyNoFilteredDesc: "Reset the filter or assign cameras to the selected location in settings.",
  refreshFromCloud: "Refresh from cloud",
  showAllCameras: "Show all cameras",
  configureStores: "Configure locations",
  toastBootstrapError: "Failed to load dashboard data",
  toastSimCameraTitle: "Camera emulation",
  toastSimSnapshotDesc: "Saving snapshots to the server gallery works for real cameras only.",
  toastSnapshotSaved: "Snapshot saved to gallery",
  toastSnapshotError: "Failed to capture snapshot",
  toastSimClipDesc: "Recording MP4 clips to the server gallery works for real cameras only.",
  toastRecordingClip: "Recording MP4 clip...",
  toastClipSaved: "Video clip saved to gallery",
  toastClipError: "Failed to save clip",
  toastFileDeleted: "File deleted",
  toastSimCameraUpdated: "Emulated camera settings updated",
  toastCameraSaved: "Camera settings saved",
  toastSimStoreUpdated: "Emulated location \"{name}\" updated",
  toastStoreUpdated: "Location \"{name}\" updated",
  toastStoreCreated: "Location \"{name}\" created",
  toastSimStoreDeleted: "Emulated location \"{name}\" deleted",
  toastStoreDeleted: "Location \"{name}\" deleted",
  toastCamerasRefreshed: "Camera list updated",
  toastCamerasRefreshedDesc: "Cameras found: {count}",

  openFocusAria: "Open focus view for {label}",
  simBadge: "SIM",
  muteAudioAria: "Mute audio for {label}",
  unmuteAudioAria: "Unmute audio for {label}",
  muteAudioTooltip: "Mute audio",
  listenAudioTooltip: "Listen to audio",
  stopTalkAria: "Stop talking to {label}",
  startTalkAria: "Talk to {label}",
  stopTalkTooltip: "Turn off microphone",
  connectingTalkTooltip: "Connecting...",
  startTalkTooltip: "Talk through camera",
  snapshotAria: "Snapshot from {label}",
  snapshotTooltip: "Save snapshot to gallery",
  editCameraAria: "Configure {label}",
  editCameraTooltip: "Name and location",
  expandCameraAria: "Expand {label}",
  expandCameraTooltip: "Open controls & HD",

  stageCameraOffline: "Camera is offline",
  stageSimStreamError: "Stream error (simulated)",
  stageWebCodecsUnsupported: "WebCodecs H.264 is not supported by this browser",
  stageStreamUnavailable: "Stream unavailable",
  stageConnecting: "Connecting",
  stageMseUnsupported: "Codec not supported by MSE",
  stageMseError: "MSE error",
  stageHdStream: "HD stream",
  stageStreamError: "Stream error",

  backToGrid: "Back to grid",
  editCameraOrStoreAria: "Rename or change location",
  prevCameraAria: "Previous camera",
  prevCameraTooltip: "Previous (←)",
  resumeCycleAria: "Resume cycle",
  pauseCycleAria: "Pause cycle",
  resumeCycleTooltip: "Resume auto-cycle",
  pauseCycleTooltip: "Pause auto-cycle",
  nextCameraAria: "Next camera",
  nextCameraTooltip: "Next (→)",
  tabControl: "Controls",
  tabArchive: "SD Archive",
  soundConnecting: "Audio...",
  soundOn: "Audio on",
  soundOff: "Audio",
  talkConnecting: "Linking...",
  talkLive: "On air",
  talkIdle: "Talk",
  audioGainLabel: "Audio gain",
  micOpenSpeak: "Microphone open — speak",
  cameraMicZero: "Camera mic is at 0%",
  enable80Pct: "Set to 80%",
  captureSnapshot: "Snapshot",
  captureClipMp4: "MP4 Clip",
  ptzTitle: "Pan / Tilt (PTZ)",
  cameraOfflineNote: "Camera is offline.",
  ptzUnsupported: "This model does not support motorized pan/tilt.",
  ptzUpAria: "Tilt up",
  ptzLeftAria: "Pan left",
  ptzRightAria: "Pan right",
  ptzDownAria: "Tilt down",
  ptzStepAria: "PTZ step size",
  privacyTitle: "Privacy shutter",
  privacyClosed: "Closed",
  privacyOpen: "Open",
  refreshStatusAria: "Refresh status",
  openLens: "Open lens",
  closeLensEllipsis: "Close lens...",
  sdMissing: "No SD card",
  sdReady: "SD card ready",
  sdArchiveTitle: "SD card archive",
  sdMissingNote:
    "No SD card is inserted or formatted in this camera. Use Snapshot or MP4 Clip to save to the local gallery.",
  loadingRecordings: "Loading recordings...",
  archiveLoadError: "Failed to load archive",
  noRecordingsForDate: "No recordings found on SD card for the selected date.",
  clipPlaying: "Playing",
  clipWatch: "Watch",
  privacyDialogEnableTitle: "Enable privacy mode?",
  privacyDialogDisableTitle: "Disable privacy mode?",
  privacyDialogEnableDesc:
    "Camera \"{label}\" will physically close its lens and stop streaming and recording.",
  privacyDialogDisableDesc:
    "Camera \"{label}\" will open its lens and resume capturing.",
  privacyDialogEnableAction: "Enable privacy",
  privacyDialogDisableAction: "Open lens",
  toastCameraCheckFailed: "Failed to check camera",
  toastPtzFailed: "Pan/tilt failed",
  toastSimLensClosed: "Simulated: lens closed",
  toastSimLensOpened: "Simulated: lens opened",
  toastPrivacyEnabled: "Privacy mode enabled",
  toastLensOpened: "Lens opened",
  toastPrivacyFailed: "Failed to toggle privacy mode",
  toastMicGainUpdated: "Microphone sensitivity: {vol}%",
  toastMicGainFailed: "Failed to change microphone volume",

  galleryTitle: "Snapshots & Clips Gallery",
  galleryFilterAria: "Gallery filter",
  galleryFilterAll: "All ({count})",
  galleryFilterSnapshots: "Snapshots",
  galleryFilterClips: "Clips",
  galleryEmptyTitle: "No saved files yet",
  galleryEmptyDesc:
    "Click Snapshot or MP4 Clip on any camera — files are saved on the server and appear here.",

  cameraEditTitle: "Camera settings",
  cameraEditSystemName: "System name: {alias} · {model}",
  cameraEditNameLabel: "Display name",
  cameraEditNamePlaceholder: "e.g., Front Desk",
  cameraEditNameHint: "Saved directly on the Tapo server and synced with the mobile app.",
  cameraEditStoreLabel: "Location",
  cameraEditStorePlaceholder: "Select location",
  storeEditTitle: "Rename location",
  storeCreateTitle: "New location (group)",
  storeDialogDesc: "Synced with rooms in your Tapo Cloud account.",
  storeNameLabel: "Name",
  storeNamePlaceholder: "e.g., Office or Main Hall",
  systemTitle: "System & Settings",
  systemDesc: "Stream configuration, location management, telemetry, and relay logs.",
  tabStream: "Stream & Wall",
  tabStores: "Locations & Cameras",
  tabDiagnostics: "Diagnostics",
  tabAccount: "Account",
  settingsAppliedToast: "Video wall settings applied",
  languageSettingLabel: "Interface language",
  languageSettingHint: "Applies immediately across the web UI and server error messages.",
  transportLabel: "Grid transport",
  transportDesc: "WebCodecs feeds raw MPEG-TS directly to the browser decoder with zero transcoding.",
  transportWebCodecs: "WebCodecs + Mediabunny TS (0% server CPU)",
  transportMjpeg: "MJPEG (compatible fallback)",
  qualityLabel: "Grid stream quality",
  qualityDesc: "Use VGA 720p for 4G modems; opening focus view automatically switches to HD.",
  qualityVga: "VGA (720p, bandwidth saver)",
  qualityHd: "HD (1080p, full)",
  fpsLabel: "Grid frame rate",
  fpsDesc: "Max decodes every frame from the camera; 0.5–1 fps decodes key I-frames only.",
  fpsMax: "Max (camera native FPS)",
  fpsKey1: "1 fps (keyframes)",
  fpsKeyHalf: "0.5 fps (keyframes only)",
  fpsN: "{n} fps",
  autoCycleLabel: "Focus auto-cycle",
  cycleOff: "Off",
  cycleSeconds: "Every {n}s",
  secureContextAlertTitle: "Plain HTTP connection (not a secure context)",
  secureContextAlertDesc:
    "WebCodecs and microphone talkback require https:// or localhost (for example Tailscale Serve or Caddy). Over plain HTTP, grid video falls back to server MJPEG.",
  ffmpegMissingTitle: "ffmpeg not found on server",
  ffmpegMissingBadge: "Missing",
  ffmpegMissingDesc:
    "MJPEG fallback, MP4 clip export, and SD archive playback are unavailable without ffmpeg. Install ffmpeg or set FFMPEG_PATH.",
  storesTitle: "Locations ({count})",
  addStore: "Add location",
  colName: "Name",
  colCameras: "Cameras",
  colActions: "Actions",
  noStoresEmpty: "No locations created yet. All cameras are shown together.",
  badgeCloud: "Tapo Cloud",
  badgeLocal: "Local",
  editStoreAria: "Edit {name}",
  deleteStoreAria: "Delete {name}",
  cameraMappingTitle: "Camera assignments & names ({count})",
  colCamera: "Camera",
  colStore: "Location",
  colCloudAlias: "Cloud alias",
  colConfigure: "Configure",
  changeButton: "Edit",
  telemetryTitle: "Camera & device telemetry",
  colModelFw: "Model / Firmware",
  colStatus: "Status",
  colStream: "Stream",
  colKbps: "kbps",
  colPing: "Ping",
  colReconnects: "Reconn.",
  relayLogsTitle: "Relay connection log",
  noLogsYet: "No events yet.",
  accountProviderLabel: "TP-Link Tapo Account",
  terminalBound: "Terminal bound · {region}",
  syncFromCloud: "Sync cameras from cloud",
  lockDashboard: "Lock dashboard",
  logoutButton: "Sign out...",
  deleteStoreTitle: "Delete location \"{name}\"?",
  deleteStoreDesc:
    "Your cameras will remain in your Tapo account, but their assignment to this location will be removed.",
  deleteStoreConfirm: "Delete location",
  logoutTitle: "Sign out of Tapo account?",
  logoutDesc: "All active video streams will be stopped and the local session will be cleared.",
  logoutConfirm: "Sign out",

  audioMicRequiresHttps:
    "Microphone access requires HTTPS or localhost (browsers block getUserMedia over plain HTTP).",
  audioMicUnavailableOrigin: "Browser does not allow microphone access on this address",
  audioTalkError: "Two-way talk error",
  audioTalkChannelFailed: "Failed to open talkback channel with camera",
  audioMicPermissionDenied: "Microphone permission denied",
  audioMicUnavailable: "Microphone unavailable",

  emuAria: "Debug emulator",
  emuLabel: "Emulator",
  emuResetAria: "Reset emulation",
  emuResetTooltip: "Clear all emulated cameras and locations",
  emuPanelAria: "Floating Debug Emulator Panel",
  emuHeaderTitle: "Debug · Emulator",
  emuHeaderStats: "{cams} cam · {stores} loc",
  emuResetAllAria: "Reset all emulated data",
  emuCollapseAria: "Collapse debug panel",
  emuTabGenerator: "Generator",
  emuTabCameras: "Cameras ({count})",
  emuTabStores: "Locations ({count})",
  emuPresetsTitle: "Load presets",
  emuClear: "Clear",
  emuPresetLabel: "{cams} cam · {stores} loc",
  emuAllOnline: "All online",
  emuMixed: "Mixed status",
  emuAllOffline: "All offline",
  emuAddStoreTitle: "Add emulated location",
  emuStoreNameAria: "Location name",
  emuStoreNamePlaceholder: "Auto (e.g. Atrium Mall)",
  emuStoreCamsAria: "Cameras in new location",
  emuCamsZero: "0 cam",
  emuCamsPlus: "+{n} cam",
  emuAddCameraTitle: "Add emulated camera",
  emuCamNameAria: "Camera name",
  emuCamNamePlaceholder: "Auto name (e.g. Checkout 3)",
  emuAddButton: "Add",
  emuStoreAuto: "Auto (latest location)",
  emuNoCamerasEmpty: "No emulated cameras",
  emuQuickCreate4x2: "Create 4 cameras in 2 locations",
  emuToggleStatusAria: "Toggle status for {name}",
  emuToggleStatusTitle: "Click to cycle Online / Offline / Error",
  emuStatusTitle: "Status: {status}",
  emuOpenCameraAria: "Open {name}",
  emuDeleteCameraAria: "Delete {name}",
  emuCloudBadge: "Cloud",
  emuAddCamToStoreAria: "Add camera to {name}",
  emuAddCamToStoreTooltip: "+1 emulated camera here",
  emuDeleteStoreAria: "Delete location {name}",
} as const;

export type I18nKey = keyof typeof EN_MESSAGES;

const RU_MESSAGES: Record<I18nKey, string> = {
  appName: "Tapo Admin",
  loadingDashboard: "Загрузка панели...",
  cancel: "Отмена",
  save: "Сохранить",
  create: "Создать",
  close: "Закрыть",
  delete: "Удалить",
  edit: "Изменить",
  back: "Назад",
  reset: "Сбросить",
  applySettings: "Применить настройки",
  download: "Скачать",
  online: "Онлайн",
  offline: "Офлайн",
  error: "Ошибка",
  connecting: "Подключение",
  idle: "Ожидание",
  encrypted: "Зашифрован",
  auto: "Авто",
  languageLabel: "Язык",
  languageAuto: "Авто (система)",
  languageEn: "English",
  languageRu: "Русский",

  accessGateBadge: "Защищённый доступ",
  accessGateDescription: "Введите пароль доступа к панели управления.",
  accessGatePasswordLabel: "Пароль доступа",
  accessGatePasswordPlaceholder: "Введите пароль",
  accessGatePasswordHint: "Задаётся переменной TAPO_ACCESS_PASSWORD на сервере.",
  accessGateSubmit: "Разблокировать",
  accessGateErrorTitle: "Доступ запрещён",
  accessGateErrorFallback: "Не удалось разблокировать панель",

  authBadge: "Cloud Monitor",
  authMfaDescription: "Подтвердите вход для {email}",
  authLoginDescription: "Подключите аккаунт TP-Link Tapo для управления камерами всех точек.",
  authErrorTitle: "Не удалось выполнить вход",
  authLoginErrorFallback: "Ошибка авторизации",
  authMfaSendErrorFallback: "Не удалось отправить код",
  authMfaVerifyErrorFallback: "Неверный код подтверждения",
  authSendEmailCode: "Отправить код на email",
  authSendSmsCode: "Отправить SMS",
  authMfaCodeLabel: "Код подтверждения (2FA)",
  authMfaCodePlaceholder: "6-значный код",
  authMfaCodeHint: "Устройство привяжется к аккаунту локально, повторный ввод кода не потребуется.",
  authConfirmSignIn: "Подтвердить вход",
  authEmailLabel: "Email аккаунта Tapo",
  authEmailPlaceholder: "owner@example.com",
  authPasswordLabel: "Пароль",
  authPasswordHint: "Пароль используется только для получения токена и не сохраняется на диск.",
  authSignInButton: "Войти в Tapo Cloud",

  headerStatusAria: "Статус и фильтр по точкам",
  headerOnlineCountTitle: "Камер в сети: {online} из {total}",
  filterAll: "Все",
  filterAllStores: "Все точки",
  filterUnassigned: "Без точки",
  moreStoresAria: "Ещё точек: {count}",
  createStoreAria: "Создать точку",
  createStoreTooltip: "Создать точку",
  searchCameraAria: "Поиск камеры",
  searchCameraPlaceholder: "Поиск камеры...",
  gridLayoutAria: "Плотность сетки",
  gridLayoutAuto: "Авто",
  galleryAria: "Галерея снимков и клипов",
  galleryLabel: "Галерея",
  galleryTooltip: "Сохранённые снимки и видеоклипы",
  systemAria: "Настройки, точки и диагностика",
  systemLabel: "Система",
  systemTooltip: "Настройки потоков, точки, диагностика",
  emptyNoCamerasTitle: "Нет камер в аккаунте",
  emptyNoFilteredTitle: "В этой выборке камер нет",
  emptyNoCamerasDesc: "Синхронизируйте список устройств из облака Tapo.",
  emptyNoFilteredDesc: "Сбросьте фильтр или привяжите камеры к выбранной точке в настройках.",
  refreshFromCloud: "Обновить из облака",
  showAllCameras: "Показать все камеры",
  configureStores: "Настроить точки",
  toastBootstrapError: "Не удалось загрузить данные",
  toastSimCameraTitle: "Эмуляция камеры",
  toastSimSnapshotDesc: "Сохранение снимков в серверную галерею работает для реальных камер.",
  toastSnapshotSaved: "Снимок сохранён в галерею",
  toastSnapshotError: "Не удалось сделать снимок",
  toastSimClipDesc: "Запись клипов MP4 в серверную галерею работает для реальных камер.",
  toastRecordingClip: "Запись клипа MP4...",
  toastClipSaved: "Видеоклип сохранён в галерею",
  toastClipError: "Не удалось сохранить клип",
  toastFileDeleted: "Файл удалён",
  toastSimCameraUpdated: "Параметры эмулированной камеры обновлены",
  toastCameraSaved: "Настройки камеры сохранены",
  toastSimStoreUpdated: "Эмулированная точка «{name}» обновлена",
  toastStoreUpdated: "Точка «{name}» обновлена",
  toastStoreCreated: "Точка «{name}» создана",
  toastSimStoreDeleted: "Эмулированная точка «{name}» удалена",
  toastStoreDeleted: "Точка «{name}» удалена",
  toastCamerasRefreshed: "Список камер обновлён",
  toastCamerasRefreshedDesc: "Найдено камер: {count}",

  openFocusAria: "Открыть фокус камеры {label}",
  simBadge: "SIM",
  muteAudioAria: "Выключить звук {label}",
  unmuteAudioAria: "Включить звук {label}",
  muteAudioTooltip: "Выключить звук",
  listenAudioTooltip: "Слушать звук",
  stopTalkAria: "Отключить микрофон {label}",
  startTalkAria: "Говорить в {label}",
  stopTalkTooltip: "Выключить микрофон",
  connectingTalkTooltip: "Подключение...",
  startTalkTooltip: "Говорить через камеру",
  snapshotAria: "Снимок с {label}",
  snapshotTooltip: "Снимок в галерею",
  editCameraAria: "Настроить {label}",
  editCameraTooltip: "Имя и точка",
  expandCameraAria: "Развернуть {label}",
  expandCameraTooltip: "Открыть управление и HD",

  stageCameraOffline: "Камера не в сети",
  stageSimStreamError: "Ошибка потока (эмуляция)",
  stageWebCodecsUnsupported: "WebCodecs H.264 не поддерживается браузером",
  stageStreamUnavailable: "Поток недоступен",
  stageConnecting: "Подключение",
  stageMseUnsupported: "Кодек не поддерживается MSE",
  stageMseError: "Ошибка MSE",
  stageHdStream: "HD-поток",
  stageStreamError: "Ошибка потока",

  backToGrid: "К сетке",
  editCameraOrStoreAria: "Переименовать или сменить точку",
  prevCameraAria: "Предыдущая камера",
  prevCameraTooltip: "Предыдущая (←)",
  resumeCycleAria: "Возобновить цикл",
  pauseCycleAria: "Пауза цикла",
  resumeCycleTooltip: "Возобновить авто-цикл",
  pauseCycleTooltip: "Пауза авто-цикла",
  nextCameraAria: "Следующая камера",
  nextCameraTooltip: "Следующая (→)",
  tabControl: "Управление",
  tabArchive: "Архив SD",
  soundConnecting: "Звук...",
  soundOn: "Звук вкл",
  soundOff: "Звук",
  talkConnecting: "Связь...",
  talkLive: "В эфире",
  talkIdle: "Говорить",
  audioGainLabel: "Усиление звука",
  micOpenSpeak: "Микрофон открыт — говорите",
  cameraMicZero: "Микрофон камеры на 0%",
  enable80Pct: "Включить 80%",
  captureSnapshot: "Снимок",
  captureClipMp4: "Клип MP4",
  ptzTitle: "Поворот (PTZ)",
  cameraOfflineNote: "Камера офлайн.",
  ptzUnsupported: "Модель без моторизированного поворота.",
  ptzUpAria: "Повернуть вверх",
  ptzLeftAria: "Повернуть влево",
  ptzRightAria: "Повернуть вправо",
  ptzDownAria: "Повернуть вниз",
  ptzStepAria: "Размер шага PTZ",
  privacyTitle: "Шторка приватности",
  privacyClosed: "Закрыта",
  privacyOpen: "Открыта",
  refreshStatusAria: "Обновить статус",
  openLens: "Открыть объектив",
  closeLensEllipsis: "Закрыть объектив...",
  sdMissing: "SD-карта отсутствует",
  sdReady: "SD-карта готова",
  sdArchiveTitle: "Архив на карте",
  sdMissingNote:
    "В камеру не вставлена SD-карта или она не отформатирована. Используйте кнопки «Снимок» и «Клип MP4» для сохранения в локальную галерею.",
  loadingRecordings: "Загрузка записей...",
  archiveLoadError: "Ошибка загрузки архива",
  noRecordingsForDate: "За выбранную дату роликов на SD-карте не найдено.",
  clipPlaying: "Играет",
  clipWatch: "Смотреть",
  privacyDialogEnableTitle: "Включить режим приватности?",
  privacyDialogDisableTitle: "Отключить режим приватности?",
  privacyDialogEnableDesc:
    "Камера «{label}» физически закроет объектив, прекратит трансляцию и запись.",
  privacyDialogDisableDesc:
    "Камера «{label}» откроет объектив и возобновит съёмку на точке.",
  privacyDialogEnableAction: "Включить приватность",
  privacyDialogDisableAction: "Открыть объектив",
  toastCameraCheckFailed: "Не удалось проверить камеру",
  toastPtzFailed: "Поворот не выполнен",
  toastSimLensClosed: "Эмуляция: объектив закрыт",
  toastSimLensOpened: "Эмуляция: объектив открыт",
  toastPrivacyEnabled: "Режим приватности включён",
  toastLensOpened: "Объектив открыт",
  toastPrivacyFailed: "Не удалось переключить режим приватности",
  toastMicGainUpdated: "Чувствительность микрофона: {vol}%",
  toastMicGainFailed: "Не удалось изменить громкость микрофона",

  galleryTitle: "Галерея снимков и клипов",
  galleryFilterAria: "Фильтр галереи",
  galleryFilterAll: "Все ({count})",
  galleryFilterSnapshots: "Снимки",
  galleryFilterClips: "Клипы",
  galleryEmptyTitle: "Пока нет сохранённых файлов",
  galleryEmptyDesc:
    "Нажмите «Снимок» или «Клип MP4» на любой камере — файлы сохранятся на сервер и появятся здесь.",

  cameraEditTitle: "Настройка камеры",
  cameraEditSystemName: "Системное имя: {alias} · {model}",
  cameraEditNameLabel: "Отображаемое имя",
  cameraEditNamePlaceholder: "Например, Касса",
  cameraEditNameHint: "Имя сохраняется прямо на сервере Tapo и синхронизируется с приложением.",
  cameraEditStoreLabel: "Точка продаж",
  cameraEditStorePlaceholder: "Выберите точку",
  storeEditTitle: "Переименовать точку",
  storeCreateTitle: "Новая точка (группа)",
  storeDialogDesc: "Группа синхронизируется с комнатами в аккаунте Tapo Cloud.",
  storeNameLabel: "Название",
  storeNamePlaceholder: "Например, Кабинет или Зал",
  systemTitle: "Система и настройки",
  systemDesc: "Конфигурация потоков, управление точками продаж, телеметрия и журнал relay.",
  tabStream: "Поток и стена",
  tabStores: "Точки и камеры",
  tabDiagnostics: "Диагностика",
  tabAccount: "Аккаунт",
  settingsAppliedToast: "Настройки видеостены применены",
  languageSettingLabel: "Язык интерфейса",
  languageSettingHint: "Применяется ко всему интерфейсу и сообщениям сервера.",
  transportLabel: "Транспорт сетки",
  transportDesc: "WebCodecs передаёт сырой MPEG-TS прямо в декодер браузера без перекодирования.",
  transportWebCodecs: "WebCodecs + Mediabunny TS (0% CPU сервера)",
  transportMjpeg: "MJPEG (совместимый резерв)",
  qualityLabel: "Качество потока в сетке",
  qualityDesc:
    "Для 4G-модемов используйте VGA 720p; при открытии фокуса автоматически включается HD.",
  qualityVga: "VGA (720p, экономный)",
  qualityHd: "HD (1080p, полный)",
  fpsLabel: "Частота кадров сетки",
  fpsDesc:
    "При «Максимум» декодируются все кадры с камеры; при 0.5–1 fps — только ключевые I-кадры.",
  fpsMax: "Максимум (нативный FPS камеры)",
  fpsKey1: "1 fps (ключевые кадры)",
  fpsKeyHalf: "0.5 fps (только ключевые кадры)",
  fpsN: "{n} fps",
  autoCycleLabel: "Авто-цикл в фокусе",
  cycleOff: "Выкл",
  cycleSeconds: "Каждые {n} с",
  secureContextAlertTitle: "Обычный HTTP (небезопасный контекст)",
  secureContextAlertDesc:
    "WebCodecs и микрофон обратной связи требуют https:// или localhost (например, Tailscale Serve или Caddy). По обычному HTTP сетка переходит на серверный MJPEG.",
  ffmpegMissingTitle: "ffmpeg не найден на сервере",
  ffmpegMissingBadge: "Отсутствует",
  ffmpegMissingDesc:
    "Резервный MJPEG, экспорт MP4-клипов и воспроизведение архива SD недоступны без ffmpeg. Установите ffmpeg или задайте FFMPEG_PATH.",
  storesTitle: "Точки продаж ({count})",
  addStore: "Добавить точку",
  colName: "Название",
  colCameras: "Камеры",
  colActions: "Действия",
  noStoresEmpty: "Пока нет созданных точек. Все камеры отображаются в общем списке.",
  badgeCloud: "Tapo Cloud",
  badgeLocal: "Локально",
  editStoreAria: "Редактировать {name}",
  deleteStoreAria: "Удалить {name}",
  cameraMappingTitle: "Привязка и названия камер ({count})",
  colCamera: "Камера",
  colStore: "Точка",
  colCloudAlias: "Облачный псевдоним",
  colConfigure: "Настроить",
  changeButton: "Изменить",
  telemetryTitle: "Телеметрия камер и устройств",
  colModelFw: "Модель / Прошивка",
  colStatus: "Статус",
  colStream: "Поток",
  colKbps: "Кбит/с",
  colPing: "Пинг",
  colReconnects: "Рекон.",
  relayLogsTitle: "Журнал relay-подключений",
  noLogsYet: "Событий пока нет.",
  accountProviderLabel: "Аккаунт TP-Link Tapo",
  terminalBound: "Терминал привязан · {region}",
  syncFromCloud: "Синхронизировать камеры из облака",
  lockDashboard: "Заблокировать панель",
  logoutButton: "Выйти из аккаунта...",
  deleteStoreTitle: "Удалить точку «{name}»?",
  deleteStoreDesc:
    "Сами камеры останутся в аккаунте Tapo, но привязка к этой точке будет удалена.",
  deleteStoreConfirm: "Удалить точку",
  logoutTitle: "Выйти из аккаунта Tapo?",
  logoutDesc: "Все активные видеопотоки будут остановлены, а локальная сессия очищена.",
  logoutConfirm: "Выйти",

  audioMicRequiresHttps:
    "Доступ к микрофону требует HTTPS или localhost (браузер блокирует getUserMedia по обычному HTTP).",
  audioMicUnavailableOrigin: "Браузер не даёт доступ к микрофону на этом адресе",
  audioTalkError: "Ошибка голосовой связи",
  audioTalkChannelFailed: "Не удалось открыть канал связи с камерой",
  audioMicPermissionDenied: "Доступ к микрофону отклонён",
  audioMicUnavailable: "Микрофон недоступен",

  emuAria: "Отладочный эмулятор",
  emuLabel: "Эмулятор",
  emuResetAria: "Сбросить эмуляцию",
  emuResetTooltip: "Очистить все эмулированные камеры и группы",
  emuPanelAria: "Плавающая панель эмулятора",
  emuHeaderTitle: "Debug · Эмулятор",
  emuHeaderStats: "{cams} кам · {stores} гр",
  emuResetAllAria: "Сбросить всё эмулированное",
  emuCollapseAria: "Свернуть панель отладки",
  emuTabGenerator: "Генератор",
  emuTabCameras: "Камеры ({count})",
  emuTabStores: "Точки ({count})",
  emuPresetsTitle: "Пресеты нагрузки",
  emuClear: "Очистить",
  emuPresetLabel: "{cams} кам · {stores} тчк",
  emuAllOnline: "Все онлайн",
  emuMixed: "Микс статусов",
  emuAllOffline: "Все офлайн",
  emuAddStoreTitle: "Добавить эмулированную точку",
  emuStoreNameAria: "Название точки",
  emuStoreNamePlaceholder: "Авто (напр. ТЦ Атриум)",
  emuStoreCamsAria: "Камер в новой точке",
  emuCamsZero: "0 кам",
  emuCamsPlus: "+{n} кам",
  emuAddCameraTitle: "Добавить эмулированную камеру",
  emuCamNameAria: "Имя камеры",
  emuCamNamePlaceholder: "Авто-имя (напр. Касса 3)",
  emuAddButton: "Добавить",
  emuStoreAuto: "Авто (последняя точка)",
  emuNoCamerasEmpty: "Нет эмулированных камер",
  emuQuickCreate4x2: "Создать 4 камеры в 2 точках",
  emuToggleStatusAria: "Переключить статус {name}",
  emuToggleStatusTitle: "Нажмите чтобы переключить Онлайн / Офлайн / Ошибка",
  emuStatusTitle: "Статус: {status}",
  emuOpenCameraAria: "Открыть {name}",
  emuDeleteCameraAria: "Удалить {name}",
  emuCloudBadge: "Облако",
  emuAddCamToStoreAria: "Добавить камеру в {name}",
  emuAddCamToStoreTooltip: "+1 эмулированная камера сюда",
  emuDeleteStoreAria: "Удалить точку {name}",
};

const MESSAGES: Record<ResolvedLanguage, Record<I18nKey, string>> = {
  en: EN_MESSAGES,
  ru: RU_MESSAGES,
};

export function getStoredLanguagePref(): LanguagePreference {
  if (typeof window === "undefined") return "auto";
  try {
    return normalizeLanguagePreference(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

function saveStoredLanguagePref(pref: LanguagePreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, pref);
  } catch {
    // ignore storage errors
  }
}

export function getSystemLocaleHint(): string | undefined {
  return typeof navigator !== "undefined" ? navigator.language : undefined;
}

export function formatHttpRequestError(
  status: number,
  pref: LanguagePreference = getStoredLanguagePref(),
): string {
  const lang = resolveLanguage(pref, getSystemLocaleHint());
  return lang === "ru" ? `Ошибка запроса (${status})` : `Request failed (${status})`;
}

export function formatDuration(seconds: number, lang: ResolvedLanguage): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (lang === "ru") {
    if (m === 0) return `${s} сек`;
    return `${m} мин ${String(s).padStart(2, "0")} с`;
  }
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function formatBytes(bytes: number, lang: ResolvedLanguage): string {
  if (lang === "ru") {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTsTime(ts: number, lang: ResolvedLanguage): string {
  return new Date(ts).toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(lang === "en" ? { hour12: false } : {}),
  });
}

export function formatTsDate(ts: number, lang: ResolvedLanguage): string {
  return new Date(ts).toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US");
}

export function relayStatusMeta(
  status: RelayStatus | undefined,
  lang: ResolvedLanguage,
): {
  label: string;
  dotClass: string;
  badgeVariant: "success" | "warning" | "error" | "secondary";
} {
  const dict = MESSAGES[lang];
  switch (status) {
    case "streaming":
      return { label: dict.online, dotClass: "bg-emerald-500", badgeVariant: "success" };
    case "connecting":
    case "reconnecting":
      return { label: dict.connecting, dotClass: "bg-amber-500", badgeVariant: "warning" };
    case "offline":
      return { label: dict.offline, dotClass: "bg-red-500", badgeVariant: "error" };
    case "encrypted":
      return { label: dict.encrypted, dotClass: "bg-red-500", badgeVariant: "error" };
    case "error":
      return { label: dict.error, dotClass: "bg-red-500", badgeVariant: "error" };
    default:
      return { label: dict.idle, dotClass: "bg-neutral-500", badgeVariant: "secondary" };
  }
}

export function formatRelayLog(entry: RelayEventLog, lang: ResolvedLanguage): string {
  if (
    entry.messageKey &&
    Object.prototype.hasOwnProperty.call(SERVER_MESSAGES[lang], entry.messageKey)
  ) {
    return tServer(lang, entry.messageKey as ServerMessageKey, entry.messageParams);
  }
  return entry.message;
}

interface I18nContextValue {
  languagePref: LanguagePreference;
  lang: ResolvedLanguage;
  setLanguagePref: (next: LanguagePreference) => void;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [languagePref, setLanguagePrefState] = useState<LanguagePreference>(() =>
    getStoredLanguagePref(),
  );

  const lang = useMemo<ResolvedLanguage>(
    () => resolveLanguage(languagePref, getSystemLocaleHint()),
    [languagePref],
  );

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLanguagePref = useCallback((next: LanguagePreference) => {
    const normalized = normalizeLanguagePreference(next);
    setLanguagePrefState(normalized);
    saveStoredLanguagePref(normalized);
  }, []);

  const t = useCallback(
    (key: I18nKey, params?: Record<string, string | number>): string => {
      return formatMessageTemplate(MESSAGES[lang][key], params);
    },
    [lang],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ languagePref, lang, setLanguagePref, t }),
    [languagePref, lang, setLanguagePref, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
