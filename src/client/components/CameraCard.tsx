import {
  CameraIcon,
  Maximize2Icon,
  MicIcon,
  MicOffIcon,
  PencilIcon,
  RotateCwIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import type React from "react";
import { VideoStreamStage } from "@/components/VideoStreamStage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cameraLabel, isCameraOnline, relayStatusMeta } from "@/lib/api";
import { useCameraAudio, useCameraTalk } from "@/lib/audio";
import { isSimulatedCamera } from "@/lib/debug-emulator";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CameraMeta, CameraTelemetry, DashboardSettings } from "../../shared/types";

interface CameraCardProps {
  camera: CameraMeta;
  storeName?: string;
  showStoreBadge: boolean;
  telemetry?: CameraTelemetry;
  settings: DashboardSettings;
  fillHeight?: boolean;
  onFocus: () => void;
  onEdit: () => void;
  onSnapshot: () => void;
}

export function CameraCard({
  camera,
  storeName,
  showStoreBadge,
  telemetry,
  settings,
  fillHeight = false,
  onFocus,
  onEdit,
  onSnapshot,
}: CameraCardProps): React.ReactElement {
  const { lang, t } = useI18n();
  const online = isCameraOnline(camera, telemetry);
  const label = cameraLabel(camera);
  const isSim = isSimulatedCamera(camera.deviceId);
  const statusMeta = relayStatusMeta(
    online ? telemetry?.status : telemetry?.status ?? "offline",
    lang,
  );
  const audio = useCameraAudio(camera.deviceId, online && !isSim);
  const talk = useCameraTalk(camera.deviceId, online && !isSim);

  return (
    <div
      className={cn(
        "group relative w-full overflow-hidden rounded-xl border border-border bg-black shadow-sm transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/25",
        fillHeight ? "h-full min-h-[260px]" : "aspect-video",
      )}
    >
      <button
        aria-label={t("openFocusAria", { label })}
        className="block size-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onFocus}
        type="button"
      >
        <VideoStreamStage
          className={fillHeight ? "h-full w-full aspect-auto" : undefined}
          deviceId={camera.deviceId}
          lastError={telemetry?.lastError}
          mirrorDeviceId={camera.mirrorSourceDeviceId}
          online={camera.accessPlatform === "IOT" || online}
          quality="grid"
          rotate180={Boolean(camera.orientation?.rotate180)}
          targetFps={settings.gridFps}
          telemetryStatus={telemetry?.status}
          transport={settings.gridTransport}
        />
      </button>

      {/* Top overlay: camera identifier + quick inline controls */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/70 via-black/25 to-transparent p-2.5">
        <div className="flex min-w-0 items-center gap-2 rounded-md bg-black/55 px-2 py-1 backdrop-blur-sm">
          <span
            aria-label={statusMeta.label}
            className={cn("size-2 shrink-0 rounded-full", statusMeta.dotClass)}
            title={statusMeta.label}
          />
          <span className="truncate text-xs font-medium text-white">{label}</span>
          {isSim && (
            <Badge className="bg-amber-500/20 text-amber-300" size="sm" variant="secondary">
              {t("simBadge")}
            </Badge>
          )}
          {camera.orientation?.rotate180 && (
            <Badge
              className="gap-1 bg-white/12 text-white/90"
              size="sm"
              title={t("cameraOrientationRotate180Label")}
              variant="secondary"
            >
              <RotateCwIcon aria-hidden="true" className="size-2.5" />
              <span>{t("flipped180Badge")}</span>
            </Badge>
          )}
          {showStoreBadge && storeName && (
            <Badge className="max-w-28 truncate bg-white/12 text-white/90" size="sm" variant="secondary">
              {storeName}
            </Badge>
          )}
        </div>

        <div
          className={cn(
            "pointer-events-auto flex items-center gap-1 transition-opacity duration-150",
            audio.listening || talk.state !== "idle"
              ? "opacity-100"
              : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          {online && !isSim && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={
                        audio.listening
                          ? t("muteAudioAria", { label })
                          : t("unmuteAudioAria", { label })
                      }
                      aria-pressed={audio.listening}
                      className={cn(
                        "bg-black/65 text-white hover:bg-black/85",
                        audio.listening && "bg-emerald-600/90 hover:bg-emerald-600",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        audio.toggle();
                      }}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  {audio.listening ? (
                    <Volume2Icon aria-hidden="true" />
                  ) : (
                    <VolumeXIcon aria-hidden="true" />
                  )}
                </TooltipTrigger>
                <TooltipPopup>
                  {audio.listening ? t("muteAudioTooltip") : t("listenAudioTooltip")}
                </TooltipPopup>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={
                        talk.state === "live"
                          ? t("stopTalkAria", { label })
                          : t("startTalkAria", { label })
                      }
                      aria-pressed={talk.state === "live"}
                      className={cn(
                        "bg-black/65 text-white hover:bg-black/85",
                        talk.state === "live" && "bg-red-600/90 hover:bg-red-600",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        talk.toggle();
                      }}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  {talk.state === "live" || talk.state === "connecting" ? (
                    <MicIcon aria-hidden="true" />
                  ) : (
                    <MicOffIcon aria-hidden="true" />
                  )}
                </TooltipTrigger>
                <TooltipPopup>
                  {talk.state === "live"
                    ? t("stopTalkTooltip")
                    : talk.state === "connecting"
                      ? t("connectingTalkTooltip")
                      : t("startTalkTooltip")}
                </TooltipPopup>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={t("snapshotAria", { label })}
                      className="bg-black/65 text-white hover:bg-black/85"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSnapshot();
                      }}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  <CameraIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup>{t("snapshotTooltip")}</TooltipPopup>
              </Tooltip>
            </>
          )}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t("editCameraAria", { label })}
                  className="bg-black/65 text-white hover:bg-black/85"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit();
                  }}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <PencilIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>{t("editCameraTooltip")}</TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t("expandCameraAria", { label })}
                  className="bg-black/65 text-white hover:bg-black/85"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFocus();
                  }}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <Maximize2Icon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>{t("expandCameraTooltip")}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
