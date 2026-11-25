import {
  BugIcon,
  FolderPlusIcon,
  Maximize2Icon,
  MinusIcon,
  PlusIcon,
  PowerIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  VideoIcon,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Group, GroupSeparator } from "@/components/ui/group";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { groupHealthMeta } from "@/lib/api";
import {
  addEmulatedCamera,
  addEmulatedStore,
  applyEmulatedPreset,
  deleteEmulatedCamera,
  deleteEmulatedStore,
  EMPTY_EMULATED_STATE,
  isSimulatedStore,
  setEmulatedCamerasMode,
  type EmulatedCamera,
  type EmulatedState,
  type SimulatedCameraStatus,
  updateEmulatedCamera,
} from "@/lib/debug-emulator";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Store } from "../../shared/types";

interface DebugEmulatorDockProps {
  emulated: EmulatedState;
  allStores: Store[];
  realStores: Store[];
  storeOnlineCounts: Map<string, number>;
  onChange: (next: EmulatedState) => void;
  onSelectStoreFilter: (storeId: string) => void;
  onFocusCamera: (deviceId: string) => void;
}

const MODEL_ITEMS = [
  { label: "Tapo C200", value: "C200" },
  { label: "Tapo C210", value: "C210" },
  { label: "Tapo C310", value: "C310" },
  { label: "Tapo C520WS", value: "C520WS" },
] as const;

const NEXT_STATUS: Record<SimulatedCameraStatus, SimulatedCameraStatus> = {
  online: "offline",
  offline: "error",
  error: "online",
};

export function DebugEmulatorDock({
  emulated,
  allStores,
  realStores,
  storeOnlineCounts,
  onChange,
  onSelectStoreFilter,
  onFocusCamera,
}: DebugEmulatorDockProps): React.ReactElement {
  const { lang, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"generator" | "cameras" | "stores">("generator");

  const [newStoreName, setNewStoreName] = useState("");
  const [newStoreCams, setNewStoreCams] = useState("2");

  const [newCamName, setNewCamName] = useState("");
  const [newCamModel, setNewCamModel] = useState<EmulatedCamera["model"]>("C200");
  const [newCamStoreId, setNewCamStoreId] = useState<string>("__auto__");
  const [newCamStatus, setNewCamStatus] = useState<SimulatedCameraStatus>("online");

  const hasSim = emulated.cameras.length > 0 || emulated.stores.length > 0;

  const statusItems: Array<{ label: string; value: SimulatedCameraStatus }> = [
    { label: t("online"), value: "online" },
    { label: t("offline"), value: "offline" },
    { label: t("error"), value: "error" },
  ];

  const statusBadge: Record<
    SimulatedCameraStatus,
    { label: string; dot: string; text: string }
  > = {
    online: { label: t("online"), dot: "bg-emerald-400", text: "text-emerald-400" },
    offline: { label: t("offline"), dot: "bg-neutral-500", text: "text-muted-foreground" },
    error: { label: t("error"), dot: "bg-red-500", text: "text-red-400" },
  };

  const storeSelectItems = [
    { label: t("emuStoreAuto"), value: "__auto__" },
    { label: t("filterUnassigned"), value: "__none__" },
    ...allStores.map((s) => ({
      label: isSimulatedStore(s.id) ? `${s.name} (sim)` : s.name,
      value: s.id,
    })),
  ];

  const inlineAssignItems = [
    { label: t("filterUnassigned"), value: "__none__" },
    ...allStores.map((s) => ({ label: s.name, value: s.id })),
  ];

  const storeCamCountItems = [
    { label: t("emuCamsZero"), value: "0" },
    { label: "+1", value: "1" },
    { label: "+2", value: "2" },
    { label: "+4", value: "4" },
  ];

  function resolveTargetStoreId(): string | null {
    if (newCamStoreId === "__none__") return null;
    if (newCamStoreId === "__auto__") {
      return emulated.stores.at(-1)?.id ?? allStores[0]?.id ?? null;
    }
    return newCamStoreId;
  }

  function handleAddStore(e: React.FormEvent) {
    e.preventDefault();
    const { nextState, createdStore } = addEmulatedStore(
      emulated,
      {
        name: newStoreName,
        initialCameras: Number(newStoreCams) || 0,
      },
      lang,
    );
    onChange(nextState);
    setNewStoreName("");
    setNewCamStoreId(createdStore.id);
  }

  function handleAddCamera(e: React.FormEvent) {
    e.preventDefault();
    const { nextState } = addEmulatedCamera(
      emulated,
      {
        name: newCamName,
        model: newCamModel,
        storeId: resolveTargetStoreId(),
        status: newCamStatus,
      },
      lang,
    );
    onChange(nextState);
    setNewCamName("");
  }

  if (!expanded) {
    return (
      <div className="fixed right-3 bottom-3 z-40">
        <Group aria-label={t("emuAria")}>
          <Button
            className="h-8 gap-2 bg-popover/90 text-xs shadow-lg backdrop-blur-md sm:h-8"
            onClick={() => setExpanded(true)}
            size="sm"
            variant="outline"
          >
            <BugIcon
              aria-hidden="true"
              className={cn(hasSim ? "text-amber-400" : "text-muted-foreground")}
            />
            <span>{t("emuLabel")}</span>
            {hasSim && (
              <Badge className="tabular-nums" size="sm" variant="secondary">
                +{emulated.cameras.length} / +{emulated.stores.length}
              </Badge>
            )}
          </Button>
          {hasSim && (
            <>
              <GroupSeparator />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={t("emuResetAria")}
                      className="h-8 w-8 bg-popover/90 px-0 text-muted-foreground shadow-lg backdrop-blur-md hover:text-destructive-foreground sm:h-8"
                      onClick={() => {
                        onChange(EMPTY_EMULATED_STATE);
                        onSelectStoreFilter("all");
                      }}
                      size="sm"
                      variant="outline"
                    />
                  }
                >
                  <RotateCcwIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup>{t("emuResetTooltip")}</TooltipPopup>
              </Tooltip>
            </>
          )}
        </Group>
      </div>
    );
  }

  return (
    <aside
      aria-label={t("emuPanelAria")}
      className="fixed right-3 bottom-3 z-40 flex max-h-[78dvh] w-[min(368px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-input bg-popover/95 shadow-2xl backdrop-blur-md"
    >
      {/* Floating Header */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <BugIcon
            aria-hidden="true"
            className={cn("size-4 shrink-0", hasSim ? "text-amber-400" : "text-muted-foreground")}
          />
          <span className="truncate text-xs font-semibold">{t("emuHeaderTitle")}</span>
          {hasSim && (
            <Badge className="tabular-nums" size="sm" variant="outline">
              {t("emuHeaderStats", {
                cams: emulated.cameras.length,
                stores: emulated.stores.length,
              })}
            </Badge>
          )}
        </div>

        <Group>
          {hasSim && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={t("emuResetAllAria")}
                      className="h-7 w-7 px-0 text-destructive-foreground sm:h-7"
                      onClick={() => {
                        onChange(EMPTY_EMULATED_STATE);
                        onSelectStoreFilter("all");
                      }}
                      size="xs"
                      variant="outline"
                    />
                  }
                >
                  <RotateCcwIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup>{t("emuResetAria")}</TooltipPopup>
              </Tooltip>
              <GroupSeparator />
            </>
          )}
          <Button
            aria-label={t("emuCollapseAria")}
            className="h-7 w-7 px-0 sm:h-7"
            onClick={() => setExpanded(false)}
            size="xs"
            variant="outline"
          >
            <MinusIcon aria-hidden="true" />
          </Button>
        </Group>
      </div>

      <Tabs
        className="flex min-h-0 flex-1 flex-col gap-2 p-2.5"
        onValueChange={(v) => setTab(v as "generator" | "cameras" | "stores")}
        value={tab}
      >
        <TabsList className="w-full shrink-0">
          <TabsTab className="flex-1 text-xs" value="generator">
            {t("emuTabGenerator")}
          </TabsTab>
          <TabsTab className="flex-1 text-xs" value="cameras">
            {t("emuTabCameras", { count: emulated.cameras.length })}
          </TabsTab>
          <TabsTab className="flex-1 text-xs" value="stores">
            {t("emuTabStores", { count: allStores.length })}
          </TabsTab>
        </TabsList>

        {/* Tab 1: Presets + Add Group + Add Camera */}
        <TabsPanel className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5" value="generator">
          {/* Quick Scale Presets */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
              <span className="flex items-center gap-1">
                <SparklesIcon aria-hidden="true" className="size-3" />
                {t("emuPresetsTitle")}
              </span>
              {hasSim && (
                <button
                  className="cursor-pointer text-[11px] text-amber-400 hover:underline"
                  onClick={() => onChange(EMPTY_EMULATED_STATE)}
                  type="button"
                >
                  {t("emuClear")}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  [4, 2],
                  [9, 4],
                  [16, 8],
                  [24, 12],
                ] as const
              ).map(([cams, stores]) => (
                <Button
                  key={`${cams}-${stores}`}
                  onClick={() => {
                    onChange(applyEmulatedPreset(emulated, cams, stores, realStores, lang));
                    onSelectStoreFilter("all");
                  }}
                  size="xs"
                  variant="outline"
                >
                  {t("emuPresetLabel", { cams, stores })}
                </Button>
              ))}
            </div>

            {emulated.cameras.length > 0 && (
              <Group className="w-full pt-0.5">
                <Button
                  className="flex-1 text-[11px]"
                  onClick={() => onChange(setEmulatedCamerasMode(emulated, "all-online"))}
                  size="xs"
                  variant="outline"
                >
                  {t("emuAllOnline")}
                </Button>
                <GroupSeparator />
                <Button
                  className="flex-1 text-[11px]"
                  onClick={() => onChange(setEmulatedCamerasMode(emulated, "mixed"))}
                  size="xs"
                  variant="outline"
                >
                  {t("emuMixed")}
                </Button>
                <GroupSeparator />
                <Button
                  className="flex-1 text-[11px]"
                  onClick={() => onChange(setEmulatedCamerasMode(emulated, "all-offline"))}
                  size="xs"
                  variant="outline"
                >
                  {t("emuAllOffline")}
                </Button>
              </Group>
            )}
          </div>

          {/* Add Group Form */}
          <form
            className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2.5"
            onSubmit={handleAddStore}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <FolderPlusIcon aria-hidden="true" className="size-3.5" />
              {t("emuAddStoreTitle")}
            </span>
            <Group className="w-full">
              <Input
                aria-label={t("emuStoreNameAria")}
                className="min-w-0 flex-1"
                onChange={(e) => setNewStoreName(e.target.value)}
                placeholder={t("emuStoreNamePlaceholder")}
                size="sm"
                value={newStoreName}
              />
              <GroupSeparator />
              <Select
                items={storeCamCountItems}
                onValueChange={(v) => setNewStoreCams(String(v))}
                value={newStoreCams}
              >
                <SelectTrigger aria-label={t("emuStoreCamsAria")} className="w-20 min-w-0 shrink-0" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="0">{t("emuCamsZero")}</SelectItem>
                  <SelectItem value="1">{t("emuCamsPlus", { n: 1 })}</SelectItem>
                  <SelectItem value="2">{t("emuCamsPlus", { n: 2 })}</SelectItem>
                  <SelectItem value="4">{t("emuCamsPlus", { n: 4 })}</SelectItem>
                </SelectPopup>
              </Select>
              <GroupSeparator />
              <Button size="sm" type="submit" variant="outline">
                <PlusIcon aria-hidden="true" />
              </Button>
            </Group>
          </form>

          {/* Add Camera Form */}
          <form
            className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2.5"
            onSubmit={handleAddCamera}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <VideoIcon aria-hidden="true" className="size-3.5" />
              {t("emuAddCameraTitle")}
            </span>
            <Input
              aria-label={t("emuCamNameAria")}
              onChange={(e) => setNewCamName(e.target.value)}
              placeholder={t("emuCamNamePlaceholder")}
              size="sm"
              value={newCamName}
            />
            <div className="grid grid-cols-2 gap-1.5">
              <Select
                items={[...MODEL_ITEMS]}
                onValueChange={(v) => setNewCamModel(v as EmulatedCamera["model"])}
                value={newCamModel}
              >
                <SelectTrigger className="min-w-0" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {MODEL_ITEMS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>

              <Select
                items={statusItems}
                onValueChange={(v) => setNewCamStatus(v as SimulatedCameraStatus)}
                value={newCamStatus}
              >
                <SelectTrigger className="min-w-0" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {statusItems.map((st) => (
                    <SelectItem key={st.value} value={st.value}>
                      {st.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            <Group className="w-full">
              <Select
                items={storeSelectItems}
                onValueChange={(v) => setNewCamStoreId(String(v))}
                value={newCamStoreId}
              >
                <SelectTrigger className="min-w-0 flex-1" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {storeSelectItems.map((it) => (
                    <SelectItem key={it.value} value={it.value}>
                      {it.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <GroupSeparator />
              <Button size="sm" type="submit" variant="default">
                <PlusIcon aria-hidden="true" />
                <span>{t("emuAddButton")}</span>
              </Button>
            </Group>
          </form>
        </TabsPanel>

        {/* Tab 2: Manage & Delete Emulated Cameras */}
        <TabsPanel className="flex min-h-0 flex-1 flex-col gap-2" value="cameras">
          {emulated.cameras.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
              <span>{t("emuNoCamerasEmpty")}</span>
              <Button
                onClick={() => onChange(applyEmulatedPreset(emulated, 4, 2, realStores, lang))}
                size="xs"
                variant="outline"
              >
                {t("emuQuickCreate4x2")}
              </Button>
            </div>
          ) : (
            <ScrollArea className="max-h-[46dvh] pr-1">
              <div className="flex flex-col gap-1.5">
                {emulated.cameras.map((cam) => {
                  const st = statusBadge[cam.status];
                  return (
                    <div
                      className="flex items-center justify-between gap-1.5 rounded-lg border bg-muted/15 px-2 py-1.5 text-xs"
                      key={cam.deviceId}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <button
                            aria-label={t("emuToggleStatusAria", { name: cam.name })}
                            className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] hover:bg-muted"
                            onClick={() =>
                              onChange(
                                updateEmulatedCamera(emulated, cam.deviceId, {
                                  status: NEXT_STATUS[cam.status],
                                }),
                              )
                            }
                            title={t("emuToggleStatusTitle")}
                            type="button"
                          >
                            <span className={cn("size-1.5 rounded-full", st.dot)} />
                          </button>
                          <span className="truncate font-medium">{cam.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {cam.model}
                          </span>
                        </div>

                        <Select
                          items={inlineAssignItems}
                          onValueChange={(v) =>
                            onChange(
                              updateEmulatedCamera(emulated, cam.deviceId, {
                                storeId: v === "__none__" ? null : String(v),
                              }),
                            )
                          }
                          value={cam.storeId ?? "__none__"}
                        >
                          <SelectTrigger className="min-h-6 min-w-0 py-0 text-[11px] sm:min-h-6" size="sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {inlineAssignItems.map((it) => (
                              <SelectItem key={it.value} value={it.value}>
                                {it.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          aria-label={t("emuStatusTitle", { status: st.label })}
                          className={st.text}
                          onClick={() =>
                            onChange(
                              updateEmulatedCamera(emulated, cam.deviceId, {
                                status: NEXT_STATUS[cam.status],
                              }),
                            )
                          }
                          size="icon-xs"
                          title={t("emuStatusTitle", { status: st.label })}
                          variant="ghost"
                        >
                          <PowerIcon aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={t("emuOpenCameraAria", { name: cam.name })}
                          onClick={() => onFocusCamera(cam.deviceId)}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <Maximize2Icon aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={t("emuDeleteCameraAria", { name: cam.name })}
                          className="text-destructive-foreground"
                          onClick={() => onChange(deleteEmulatedCamera(emulated, cam.deviceId))}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </TabsPanel>

        {/* Tab 3: Manage Groups/Points */}
        <TabsPanel className="flex min-h-0 flex-1 flex-col gap-2" value="stores">
          <ScrollArea className="max-h-[46dvh] pr-1">
            <div className="flex flex-col gap-1.5">
              {allStores.map((st) => {
                const isSim = isSimulatedStore(st.id);
                const online = storeOnlineCounts.get(st.id) ?? 0;
                const total = st.cameraIds.length;
                const health = groupHealthMeta(online, total);
                return (
                  <div
                    className="flex items-center justify-between gap-2 rounded-lg border bg-muted/15 px-2.5 py-1.5 text-xs"
                    key={st.id}
                  >
                    <button
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:underline"
                      onClick={() => onSelectStoreFilter(st.id)}
                      type="button"
                    >
                      <span className={cn("size-1.5 shrink-0 rounded-full", health.dotClass)} />
                      <span className="truncate font-medium">{st.name}</span>
                      <Badge className="shrink-0 tabular-nums" size="sm" variant="secondary">
                        {online}/{total}
                      </Badge>
                      {!isSim && (
                        <Badge className="shrink-0" size="sm" variant="outline">
                          {t("emuCloudBadge")}
                        </Badge>
                      )}
                    </button>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              aria-label={t("emuAddCamToStoreAria", { name: st.name })}
                              onClick={() =>
                                onChange(
                                  addEmulatedCamera(
                                    emulated,
                                    {
                                      storeId: st.id,
                                    },
                                    lang,
                                  ).nextState,
                                )
                              }
                              size="icon-xs"
                              variant="ghost"
                            />
                          }
                        >
                          <PlusIcon aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipPopup>{t("emuAddCamToStoreTooltip")}</TooltipPopup>
                      </Tooltip>

                      {isSim && (
                        <Button
                          aria-label={t("emuDeleteStoreAria", { name: st.name })}
                          className="text-destructive-foreground"
                          onClick={() => onChange(deleteEmulatedStore(emulated, st.id, true))}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </TabsPanel>
      </Tabs>
    </aside>
  );
}
