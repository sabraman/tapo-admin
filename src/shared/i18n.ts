import type { LanguagePreference, ResolvedLanguage } from "./types";

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  if (value === "en" || value === "ru" || value === "auto") {
    return value;
  }
  return "auto";
}

export function resolveLanguage(
  preference: LanguagePreference | string | null | undefined,
  localeHint?: string | null,
): ResolvedLanguage {
  if (preference === "en" || preference === "ru") {
    return preference;
  }
  if (localeHint) {
    const firstTag = localeHint.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (firstTag.startsWith("ru")) {
      return "ru";
    }
  }
  return "en";
}

export const SERVER_MESSAGES = {
  en: {
    auth_required: "Not authenticated",
    auth_login_first: "Sign in to your Tapo account first",
    auth_missing_credentials: "Enter email and password",
    auth_no_mfa: "No active MFA login session",
    auth_missing_mfa_code: "Enter verification code",
    access_locked: "Dashboard password required",
    access_invalid_password: "Invalid access password",
    camera_not_found: "Camera not found",
    store_not_found: "Store not found",
    store_name_required: "Enter a store name",
    store_system_undeletable: "This Tapo system group cannot be deleted",
    file_not_found: "File not found",
    invalid_time_range: "Invalid start/end time range",
    ws_upgrade_failed: "WebSocket upgrade failed",
    not_found: "Not found",
    ffmpeg_missing: "ffmpeg binary not found; install ffmpeg or set FFMPEG_PATH",
    update_auto_unsupported: "In-app auto-update is only available in packaged desktop releases",
    login_required_for_stream: "Tapo account login required",
    session_expired_cloud: "Cloud session expired",
    session_expired_tapo: "Tapo session expired",
    session_expired_token: "Session token expired",
    login_failed_code: "Login error (code {code})",
    login_regional_failed_code: "Regional server login error (code {code})",
    login_invalid_creds: "Invalid email or password",
    login_rejected_code: "Login rejected (code {code})",
    mfa_send_failed: "Failed to send verification code (code {code})",
    mfa_rejected: "Verification code rejected (code {code})",
    camera_list_failed: "Failed to fetch camera list (code {code})",
    service_discovery_failed: "Service discovery error for {serviceId} (code {code})",
    service_not_found: "Service {serviceId} not found",
    camera_rejected_request: "Camera rejected request (code {code})",
    camera_no_response: "Camera returned no response",
    mic_error_code: "Microphone error (code {code})",
    privacy_error_code: "Privacy error (code {code})",
    ptz_rejected_code: "Pan/tilt rejected (code {code})",
    sd_error_code: "SD card error (code {code})",
    recordings_read_error: "Failed to read recordings (code {code})",
    playback_uid_error: "Playback userId error (code {code})",
    playback_uid_missing: "Camera did not return playback user_id",
    relay_rejected_code: "Cloud relay rejected (code {code})",
    relay_incomplete: "Incomplete cloud relay response",
    relay_http_status: "Relay returned status {status}",
    dev_motor_busy: "Motor busy, wait for move to finish",
    dev_motor_limit: "Pan/tilt limit reached",
    dev_privacy_on: "Privacy mode is enabled",
    dev_privacy_zone: "Movement blocked by a privacy zone",
    dev_sd_missing: "SD card is missing or unformatted",
    dev_sd_empty: "SD card not found or no recordings on selected date",
    dev_offline: "Camera is offline",
    stream_connecting: "Connecting {alias} ({resolution})",
    stream_started: "{alias}: {resolution} stream started ({ms} ms)",
    stream_encrypted: "Stream is encrypted by camera (x-if-encrypt=1)",
    stream_timeout: "Timed out waiting for relay data",
    stream_closed: "Relay connection closed",
    stream_token_refresh: "Token expired on {alias}, refreshing session",
    talk_relay_closed: "Talkback relay connection closed",
    talk_connected: "{alias}: talkback connected",
    talk_timeout: "Camera talkback timed out",
    snapshot_timeout: "Timed out capturing snapshot",
    clip_capture_failed: "Failed to capture video stream",
    clip_build_failed: "Failed to build MP4 clip",
    log_startup_cameras_failed: "Failed to load cameras on startup: {error}",
    log_cameras_refreshed: "Camera list updated: found {count}",
    log_snapshot_saved: "Snapshot saved: {filename}",
    log_clip_saved: "Clip saved: {filename}",
    log_privacy_toggled: "Privacy mode: {state}",
    state_on: "ON",
    state_off: "OFF",
  },
  ru: {
    auth_required: "Не авторизован",
    auth_login_first: "Сначала войдите в аккаунт Tapo",
    auth_missing_credentials: "Укажите email и пароль",
    auth_no_mfa: "Нет активного MFA-входа",
    auth_missing_mfa_code: "Введите код подтверждения",
    access_locked: "Требуется пароль доступа к панели",
    access_invalid_password: "Неверный пароль доступа",
    camera_not_found: "Камера не найдена",
    store_not_found: "Точка не найдена",
    store_name_required: "Введите название точки",
    store_system_undeletable: "Эту системную группу Tapo нельзя удалить",
    file_not_found: "Файл не найден",
    invalid_time_range: "Некорректный диапазон start/end",
    ws_upgrade_failed: "WebSocket upgrade failed",
    not_found: "Not found",
    ffmpeg_missing: "Бинарник ffmpeg не найден; установите ffmpeg или задайте FFMPEG_PATH",
    update_auto_unsupported: "Автообновление внутри приложения доступно только в релизной десктопной сборке",
    login_required_for_stream: "Требуется вход в аккаунт Tapo",
    session_expired_cloud: "Облачная сессия истекла",
    session_expired_tapo: "Сессия Tapo истекла",
    session_expired_token: "Токен сессии устарел",
    login_failed_code: "Ошибка входа (код {code})",
    login_regional_failed_code: "Ошибка входа на региональный сервер (код {code})",
    login_invalid_creds: "Неверный email или пароль",
    login_rejected_code: "Вход отклонён (код {code})",
    mfa_send_failed: "Не удалось отправить код подтверждения (код {code})",
    mfa_rejected: "Код подтверждения отклонён (код {code})",
    camera_list_failed: "Не удалось получить список камер (код {code})",
    service_discovery_failed: "Ошибка discovery сервиса {serviceId} (код {code})",
    service_not_found: "Сервис {serviceId} не найден",
    camera_rejected_request: "Камера отклонила запрос (код {code})",
    camera_no_response: "Камера не вернула ответ",
    mic_error_code: "Ошибка микрофона (код {code})",
    privacy_error_code: "Ошибка приватности (код {code})",
    ptz_rejected_code: "Поворот отклонён (код {code})",
    sd_error_code: "Ошибка SD-карты (код {code})",
    recordings_read_error: "Ошибка чтения записей (код {code})",
    playback_uid_error: "Ошибка playback userId (код {code})",
    playback_uid_missing: "Камера не выдала user_id для воспроизведения",
    relay_rejected_code: "Cloud relay отклонён (код {code})",
    relay_incomplete: "Неполный ответ cloud relay",
    relay_http_status: "Relay вернул статус {status}",
    dev_motor_busy: "Мотор занят, дождитесь завершения поворота",
    dev_motor_limit: "Достигнут предел поворота",
    dev_privacy_on: "Включён режим приватности",
    dev_privacy_zone: "Поворот заблокирован зоной приватности",
    dev_sd_missing: "SD-карта отсутствует или не отформатирована",
    dev_sd_empty: "SD-карта не найдена или на выбранную дату нет записей",
    dev_offline: "Камера не в сети",
    stream_connecting: "Подключение {alias} ({resolution})",
    stream_started: "{alias}: поток {resolution} пошёл ({ms} мс)",
    stream_encrypted: "Поток зашифрован камерой (x-if-encrypt=1)",
    stream_timeout: "Таймаут ожидания данных от relay",
    stream_closed: "Relay-соединение закрыто",
    stream_token_refresh: "Токен истёк на {alias}, обновляю сессию",
    talk_relay_closed: "Relay-соединение для голоса закрыто",
    talk_connected: "{alias}: голосовая связь открыта",
    talk_timeout: "Таймаут голосовой связи с камерой",
    snapshot_timeout: "Таймаут получения снимка",
    clip_capture_failed: "Не удалось захватить видеопоток",
    clip_build_failed: "Не удалось собрать MP4-клип",
    log_startup_cameras_failed: "Не удалось загрузить камеры при старте: {error}",
    log_cameras_refreshed: "Обновлён список камер: найдено {count}",
    log_snapshot_saved: "Снимок сохранён: {filename}",
    log_clip_saved: "Клип сохранён: {filename}",
    log_privacy_toggled: "Режим приватности: {state}",
    state_on: "ВКЛ",
    state_off: "ВЫКЛ",
  },
} as const;

export type ServerMessageKey = keyof typeof SERVER_MESSAGES.en;

export function formatMessageTemplate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  );
}

export function tServer(
  lang: ResolvedLanguage,
  key: ServerMessageKey,
  params?: Record<string, string | number>,
): string {
  return formatMessageTemplate(SERVER_MESSAGES[lang][key], params);
}

export const DEVICE_ERROR_KEYS: Record<number, ServerMessageKey> = {
  [-64303]: "dev_motor_busy",
  [-64304]: "dev_motor_limit",
  [-64324]: "dev_privacy_on",
  [-64336]: "dev_privacy_zone",
  [-40209]: "dev_sd_missing",
  [-71112]: "dev_sd_empty",
  [-40401]: "dev_offline",
  [-40406]: "dev_offline",
};
