import {
  CameraIcon,
  DownloadIcon,
  FilmIcon,
  FolderOpenIcon,
  ImageOffIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { formatBytes, formatTsDate, formatTsTime, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { MediaItem } from "../../shared/types";

interface MediaGalleryDialogProps {
  open: boolean;
  media: MediaItem[];
  mediaDir: string;
  initialItemId?: string | null;
  onOpenChange: (open: boolean) => void;
  onDeleteMedia: (id: string) => Promise<void>;
}

export function MediaGalleryDialog({
  open,
  media,
  mediaDir,
  initialItemId,
  onOpenChange,
  onDeleteMedia,
}: MediaGalleryDialogProps): React.ReactElement {
  const { lang, t } = useI18n();
  const [filter, setFilter] = useState<"all" | "snapshot" | "clip">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (filter === "all") return media;
    return media.filter((m) => m.kind === filter);
  }, [media, filter]);

  const selected = useMemo(
    () => filtered.find((m) => m.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  useEffect(() => {
    if (open && initialItemId) {
      setFilter("all");
      setSelectedId(initialItemId);
    }
  }, [open, initialItemId]);

  useEffect(() => {
    if (open && filtered.length > 0 && !filtered.some((m) => m.id === selectedId)) {
      setSelectedId(filtered[0]!.id);
    }
  }, [open, filtered, selectedId]);

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await onDeleteMedia(id);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-3 pe-8">
            <div className="flex flex-col gap-1">
              <DialogTitle>{t("galleryTitle")}</DialogTitle>
              <DialogDescription className="flex items-center gap-1.5 font-mono text-xs">
                <FolderOpenIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{mediaDir || ".data/media"}</span>
              </DialogDescription>
            </div>

            <SegmentedControl
              aria-label={t("galleryFilterAria")}
              render={
                <RadioGroupPrimitive
                  onValueChange={(v) => setFilter(String(v) as typeof filter)}
                  value={filter}
                />
              }
              size="sm"
            >
              <SegmentedControlItem render={<RadioPrimitive.Root value="all" />}>
                {t("galleryFilterAll", { count: media.length })}
              </SegmentedControlItem>
              <SegmentedControlItem render={<RadioPrimitive.Root value="snapshot" />}>
                {t("galleryFilterSnapshots")}
              </SegmentedControlItem>
              <SegmentedControlItem render={<RadioPrimitive.Root value="clip" />}>
                {t("galleryFilterClips")}
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
        </DialogHeader>

        <DialogPanel>
          {filtered.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ImageOffIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{t("galleryEmptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("galleryEmptyDesc")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              {/* Selected Media Preview Stage */}
              {selected && (
                <div className="flex flex-col gap-2.5">
                  <div className="relative aspect-video w-full overflow-hidden rounded-xl border bg-black">
                    {selected.kind === "snapshot" ? (
                      <img
                        alt={selected.cameraName}
                        className="size-full object-contain"
                        src={`/api/media/${encodeURIComponent(selected.id)}/file`}
                      />
                    ) : (
                      <video
                        autoPlay
                        className="size-full object-contain"
                        controls
                        key={selected.id}
                        src={`/api/media/${encodeURIComponent(selected.id)}/file`}
                      />
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {selected.kind === "snapshot" ? "JPEG" : "MP4"}
                      </Badge>
                      <span className="font-medium">{selected.cameraName}</span>
                      {selected.storeName && (
                        <span className="text-muted-foreground">· {selected.storeName}</span>
                      )}
                      <span className="font-mono text-muted-foreground tabular-nums">
                        {formatTsDate(selected.createdAt, lang)}{" "}
                        {formatTsTime(selected.createdAt, lang)} ·{" "}
                        {formatBytes(selected.sizeBytes, lang)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        render={
                          <a
                            download={selected.filename}
                            href={`/api/media/${encodeURIComponent(selected.id)}/file?download=1`}
                          />
                        }
                        size="xs"
                        variant="outline"
                      >
                        <DownloadIcon aria-hidden="true" />
                        <span>{t("download")}</span>
                      </Button>
                      <Button
                        disabled={deletingId === selected.id}
                        loading={deletingId === selected.id}
                        onClick={() => void handleDelete(selected.id)}
                        size="xs"
                        variant="destructive-outline"
                      >
                        <Trash2Icon aria-hidden="true" />
                        <span>{t("delete")}</span>
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Thumbnails List */}
              <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
                {filtered.map((item) => {
                  const active = selected?.id === item.id;
                  return (
                    <button
                      className={cn(
                        "flex items-center gap-2.5 rounded-xl border p-2 text-left transition-colors",
                        active
                          ? "border-primary/60 bg-accent"
                          : "border-border bg-card/50 hover:bg-accent/50",
                      )}
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      type="button"
                    >
                      <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black">
                        {item.kind === "snapshot" ? (
                          <img
                            alt=""
                            className="size-full object-cover"
                            src={`/api/media/${encodeURIComponent(item.id)}/file`}
                          />
                        ) : (
                          <FilmIcon aria-hidden="true" className="size-5 text-white/80" />
                        )}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
                        <div className="flex items-center gap-1.5">
                          {item.kind === "snapshot" ? (
                            <CameraIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <FilmIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate font-medium">{item.cameraName}</span>
                        </div>
                        <span className="truncate text-[11px] text-muted-foreground tabular-nums">
                          {formatTsTime(item.createdAt, lang)} · {formatBytes(item.sizeBytes, lang)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>{t("close")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
