import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowUpCircleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LockIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  StoreIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { cameraLabel, findCameraStore, isCameraOnline } from "@/lib/api";
import {
  ffmpegInstallButtonLabel,
  formatRelayLog,
  formatTsTime,
  relayStatusMeta,
  useI18n,
} from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  AppUpdateState,
  AuthState,
  CameraMeta,
  CameraOrientation,
  CameraTelemetry,
  DashboardSettings,
  FfmpegInstallState,
  GridFps,
  GridTransport,
  LanguagePreference,
  RelayEventLog,
  RuntimeCapabilities,
  Store,
  StreamQuality,
} from "../../shared/types";

/* -------------------------------------------------------------------------- */
/* Explicit Camera Edit Dialog (no inline auto-saving inputs)                 */
/* -------------------------------------------------------------------------- */

interface CameraEditDialogProps {
  camera: CameraMeta | null;
  stores: Store[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    deviceId: string,
    payload: { customName: string; storeId: string | null; orientation: CameraOrientation },
  ) => Promise<void>;
}

export function CameraEditDialog({
  camera,
  stores,
  open,
  onOpenChange,
  onSave,
}: CameraEditDialogProps): React.ReactElement {
  const { t } = useI18n();
  const [customName, setCustomName] = useState("");
  const [storeId, setStoreId] = useState<string>("__none__");
  const [rotate180, setRotate180] = useState(false);
  const [invertPtz, setInvertPtz] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !camera) return;
    setCustomName(camera.customName ?? camera.cloudNickname ?? camera.alias ?? "");
    const assigned = findCameraStore(stores, camera.deviceId);
    setStoreId(assigned?.id ?? "__none__");
    setRotate180(Boolean(camera.orientation?.rotate180));
    setInvertPtz(Boolean(camera.orientation?.invertPtz));
  }, [open, camera, stores]);

  const storeItems = [
    { label: t("filterUnassigned"), value: "__none__" },
    ...stores.map((s) => ({ label: s.name, value: s.id })),
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!camera) return;
    setSaving(true);
    try {
      await onSave(camera.deviceId, {
        customName,
        storeId: storeId === "__none__" ? null : storeId,
        orientation: { rotate180, invertPtz },
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("cameraEditTitle")}</DialogTitle>
          <DialogDescription>
            {camera
              ? t("cameraEditSystemName", { alias: camera.alias, model: camera.deviceModel })
              : ""}
          </DialogDescription>
        </DialogHeader>
        <Form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="flex flex-col gap-4">
            <Field name="customName">
              <FieldLabel>{t("cameraEditNameLabel")}</FieldLabel>
              <Input
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={camera?.alias || t("cameraEditNamePlaceholder")}
                type="text"
                value={customName}
              />
              <FieldDescription>{t("cameraEditNameHint")}</FieldDescription>
            </Field>

            <Field name="storeId">
              <FieldLabel>{t("cameraEditStoreLabel")}</FieldLabel>
              <Select
                items={storeItems}
                onValueChange={(val) => {
                  if (val !== null) setStoreId(val);
                }}
                value={storeId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("cameraEditStorePlaceholder")} />
                </SelectTrigger>
                <SelectPopup>
                  {storeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-3">
              <label className="flex items-start justify-between gap-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t("cameraOrientationRotate180Label")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("cameraOrientationRotate180Desc")}
                  </span>
                </span>
                <Switch
                  checked={rotate180}
                  onCheckedChange={(checked) => {
                    setRotate180(checked);
                    setInvertPtz(checked);
                  }}
                />
              </label>

              <label className="flex items-start justify-between gap-3 border-t pt-2.5">
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t("cameraOrientationInvertPtzLabel")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("cameraOrientationInvertPtzDesc")}
                  </span>
                </span>
                <Switch checked={invertPtz} onCheckedChange={setInvertPtz} />
              </label>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button disabled={saving} variant="ghost" />}>
              {t("cancel")}
            </DialogClose>
            <Button disabled={saving} loading={saving} type="submit">
              {t("save")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Store Create / Edit Dialog                                                 */
/* -------------------------------------------------------------------------- */

interface StoreFormDialogProps {
  open: boolean;
  initialStore: Store | null;
  onOpenChange: (open: boolean) => void;
  onSave: (data: { id?: string; name: string }) => Promise<void>;
}

export function StoreFormDialog({
  open,
  initialStore,
  onOpenChange,
  onSave,
}: StoreFormDialogProps): React.ReactElement {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialStore?.name ?? "");
  }, [open, initialStore]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        id: initialStore?.id,
        name: name.trim(),
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {initialStore ? t("storeEditTitle") : t("storeCreateTitle")}
          </DialogTitle>
          <DialogDescription>{t("storeDialogDesc")}</DialogDescription>
        </DialogHeader>
        <Form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="flex flex-col gap-4">
            <Field name="storeName">
              <FieldLabel>{t("storeNameLabel")}</FieldLabel>
              <Input
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder={t("storeNamePlaceholder")}
                required
                type="text"
                value={name}
              />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button disabled={saving} variant="ghost" />}>
              {t("cancel")}
            </DialogClose>
            <Button disabled={saving || !name.trim()} loading={saving} type="submit">
              {initialStore ? t("save") : t("create")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* System, Settings, Stores & Diagnostics Dialog                              */
/* -------------------------------------------------------------------------- */

interface SystemSettingsDialogProps {
  open: boolean;
  initialTab?: "stream" | "stores" | "diagnostics" | "account";
  auth: Extract<AuthState, { status: "authenticated" }>;
  cameras: CameraMeta[];
  stores: Store[];
  telemetry: Record<string, CameraTelemetry>;
  settings: DashboardSettings;
  logs: RelayEventLog[];
  capabilities?: RuntimeCapabilities;
  ffmpegInstall?: FfmpegInstallState;
  updateState?: AppUpdateState;
  accessRequired?: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveSettings: (next: DashboardSettings) => Promise<void>;
  onCreateStore: () => void;
  onEditStore: (store: Store) => void;
  onDeleteStore: (store: Store) => Promise<void>;
  onEditCamera: (cam: CameraMeta) => void;
  onRefreshCameras: () => Promise<void>;
  onInstallFfmpeg?: () => Promise<void>;
  onCheckUpdates?: () => Promise<void>;
  onApplyUpdate?: () => Promise<void>;
  onLock?: () => Promise<void>;
  onLogout: () => Promise<void>;
}

export function SystemSettingsDialog({
  open,
  initialTab = "stream",
  auth,
  cameras,
  stores,
  telemetry,
  settings,
  logs,
  capabilities,
  ffmpegInstall,
  updateState,
  accessRequired = false,
  onOpenChange,
  onSaveSettings,
  onCreateStore,
  onEditStore,
  onDeleteStore,
  onEditCamera,
  onRefreshCameras,
  onInstallFfmpeg,
  onCheckUpdates,
  onApplyUpdate,
  onLock,
  onLogout,
}: SystemSettingsDialogProps): React.ReactElement {
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const { lang, setLanguagePref, t } = useI18n();
  const [tab, setTab] = useState<"stream" | "stores" | "diagnostics" | "account">(initialTab);
  const [draft, setDraft] = useState<DashboardSettings>(settings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [locking, setLocking] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Store | null>(null);
  const [deletingStore, setDeletingStore] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setDraft(settings);
    }
  }, [open, initialTab, settings]);

  const qualityItems = [
    { label: t("qualityVga"), value: "VGA" },
    { label: t("qualityHd"), value: "HD" },
  ];

  const fpsItems = [
    { label: t("fpsMax"), value: "30" },
    { label: t("fpsN", { n: 10 }), value: "10" },
    { label: t("fpsN", { n: 5 }), value: "5" },
    { label: t("fpsN", { n: 3 }), value: "3" },
    { label: t("fpsN", { n: 2 }), value: "2" },
    { label: t("fpsKey1"), value: "1" },
    { label: t("fpsKeyHalf"), value: "0.5" },
  ];

  const transportItems = [
    { label: t("transportWebCodecs"), value: "webcodecs" },
    { label: t("transportMjpeg"), value: "mjpeg" },
  ];

  const cycleItems = [
    { label: t("cycleOff"), value: "0" },
    { label: t("cycleSeconds", { n: 15 }), value: "15" },
    { label: t("cycleSeconds", { n: 30 }), value: "30" },
    { label: t("cycleSeconds", { n: 60 }), value: "60" },
  ];

  const languageItems: Array<{ label: string; value: LanguagePreference }> = [
    { label: t("languageAuto"), value: "auto" },
    { label: t("languageEn"), value: "en" },
    { label: t("languageRu"), value: "ru" },
  ];

  const insecureContext = typeof window !== "undefined" && !window.isSecureContext;
  const ffmpegMissing = capabilities ? !capabilities.ffmpegAvailable : false;
  const activeFfmpegState = ffmpegInstall ?? capabilities?.ffmpegInstall;
  const ffmpegBusy =
    activeFfmpegState?.phase === "downloading" || activeFfmpegState?.phase === "verifying";

  const settingsDirty =
    draft.gridFps !== settings.gridFps ||
    draft.gridResolution !== settings.gridResolution ||
    draft.gridTransport !== settings.gridTransport ||
    draft.autoCycleSeconds !== settings.autoCycleSeconds ||
    draft.language !== settings.language;

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    try {
      await onSaveSettings(draft);
      setLanguagePref(draft.language);
      toastManager.add({ title: t("settingsAppliedToast"), type: "success" });
    } finally {
      setSavingSettings(false);
    }
  }

  async function confirmDeleteStore() {
    if (!deleteTarget) return;
    setDeletingStore(true);
    try {
      await onDeleteStore(deleteTarget);
      setDeleteTarget(null);
    } finally {
      setDeletingStore(false);
    }
  }

  async function confirmLogout() {
    setLoggingOut(true);
    try {
      await onLogout();
      setLogoutOpen(false);
      onOpenChange(false);
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogPopup className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("systemTitle")}</DialogTitle>
            <DialogDescription>{t("systemDesc")}</DialogDescription>
          </DialogHeader>

          <DialogPanel>
            <Tabs
              className="flex flex-col gap-4"
              onValueChange={(v) => setTab(v as typeof tab)}
              value={tab}
            >
              <TabsList className="w-full flex-wrap">
                <TabsTab value="stream">{t("tabStream")}</TabsTab>
                <TabsTab value="stores">{t("tabStores")}</TabsTab>
                <TabsTab value="diagnostics">{t("tabDiagnostics")}</TabsTab>
                <TabsTab value="account">{t("tabAccount")}</TabsTab>
              </TabsList>

              {/* Tab 1: Stream & UI tuning (explicit Save instead of accidental live clicks) */}
              <TabsPanel className="flex flex-col gap-4" value="stream">
                {insecureContext && (
                  <Alert variant="warning">
                    <AlertTriangleIcon aria-hidden="true" />
                    <AlertTitle>{t("secureContextAlertTitle")}</AlertTitle>
                    <AlertDescription>{t("secureContextAlertDesc")}</AlertDescription>
                  </Alert>
                )}

                {ffmpegMissing && (
                  <Alert variant="warning">
                    <AlertTriangleIcon aria-hidden="true" />
                    <AlertTitle className="flex items-center gap-2">
                      <span>{t("ffmpegMissingTitle")}</span>
                      <Badge size="sm" variant="warning">
                        {t("ffmpegMissingBadge")}
                      </Badge>
                    </AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      <span>{t("ffmpegMissingDesc")}</span>
                      {activeFfmpegState?.phase === "error" && activeFfmpegState.error && (
                        <span className="text-xs text-destructive-foreground">
                          {activeFfmpegState.error}
                        </span>
                      )}
                      {activeFfmpegState?.supported === false ? (
                        <span className="text-xs text-muted-foreground">
                          {t("ffmpegInstallUnsupported")}
                        </span>
                      ) : (
                        onInstallFfmpeg && (
                          <div className="flex items-center gap-2 pt-0.5">
                            <Button
                              disabled={ffmpegBusy}
                              loading={ffmpegBusy}
                              onClick={() => void onInstallFfmpeg()}
                              size="sm"
                              variant="default"
                            >
                              <DownloadIcon aria-hidden="true" />
                              <span>{ffmpegInstallButtonLabel(activeFfmpegState, t)}</span>
                            </Button>
                          </div>
                        )
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                <Form className="flex flex-col gap-4" onSubmit={handleSaveSettings}>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field name="gridTransport">
                      <FieldLabel>{t("transportLabel")}</FieldLabel>
                      <Select
                        items={transportItems}
                        onValueChange={(val) => {
                          if (val === "webcodecs" || val === "mjpeg") {
                            setDraft((d) => ({ ...d, gridTransport: val as GridTransport }));
                          }
                        }}
                        value={draft.gridTransport}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {transportItems.map((i) => (
                            <SelectItem key={i.value} value={i.value}>
                              {i.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <FieldDescription>{t("transportDesc")}</FieldDescription>
                    </Field>

                    <Field name="gridResolution">
                      <FieldLabel>{t("qualityLabel")}</FieldLabel>
                      <Select
                        items={qualityItems}
                        onValueChange={(val) => {
                          if (val === "VGA" || val === "HD") {
                            setDraft((d) => ({ ...d, gridResolution: val as StreamQuality }));
                          }
                        }}
                        value={draft.gridResolution}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {qualityItems.map((i) => (
                            <SelectItem key={i.value} value={i.value}>
                              {i.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <FieldDescription>{t("qualityDesc")}</FieldDescription>
                    </Field>

                    <Field name="gridFps">
                      <FieldLabel>{t("fpsLabel")}</FieldLabel>
                      <Select
                        items={fpsItems}
                        onValueChange={(val) => {
                          const num = Number(val) as GridFps;
                          if ([0.5, 1, 2, 3, 5, 10, 30].includes(num)) {
                            setDraft((d) => ({ ...d, gridFps: num }));
                          }
                        }}
                        value={String(draft.gridFps)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {fpsItems.map((i) => (
                            <SelectItem key={i.value} value={i.value}>
                              {i.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <FieldDescription>{t("fpsDesc")}</FieldDescription>
                    </Field>

                    <Field name="autoCycleSeconds">
                      <FieldLabel>{t("autoCycleLabel")}</FieldLabel>
                      <Select
                        items={cycleItems}
                        onValueChange={(val) => {
                          const num = Number(val) as DashboardSettings["autoCycleSeconds"];
                          if ([0, 15, 30, 60].includes(num)) {
                            setDraft((d) => ({ ...d, autoCycleSeconds: num }));
                          }
                        }}
                        value={String(draft.autoCycleSeconds)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {cycleItems.map((i) => (
                            <SelectItem key={i.value} value={i.value}>
                              {i.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </Field>

                    <Field className="sm:col-span-2" name="language">
                      <FieldLabel>{t("languageSettingLabel")}</FieldLabel>
                      <Select
                        items={languageItems}
                        onValueChange={(val) => {
                          if (val === "auto" || val === "en" || val === "ru") {
                            setDraft((d) => ({ ...d, language: val }));
                          }
                        }}
                        value={draft.language}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {languageItems.map((i) => (
                            <SelectItem key={i.value} value={i.value}>
                              {i.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <FieldDescription>{t("languageSettingHint")}</FieldDescription>
                    </Field>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <Button
                      disabled={!settingsDirty || savingSettings}
                      onClick={() => setDraft(settings)}
                      variant="ghost"
                    >
                      {t("reset")}
                    </Button>
                    <Button
                      disabled={!settingsDirty || savingSettings}
                      loading={savingSettings}
                      type="submit"
                    >
                      {t("applySettings")}
                    </Button>
                  </div>
                </Form>
              </TabsPanel>

              {/* Tab 2: Stores & Camera Assignment */}
              <TabsPanel className="flex flex-col gap-5" value="stores">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <StoreIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    <span>{t("storesTitle", { count: stores.length })}</span>
                  </div>
                  <Button onClick={onCreateStore} size="sm">
                    <PlusIcon aria-hidden="true" />
                    <span>{t("addStore")}</span>
                  </Button>
                </div>

                <Table variant="card">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colName")}</TableHead>
                      <TableHead>{t("colCameras")}</TableHead>
                      <TableHead className="w-28 text-right">{t("colActions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stores.length === 0 ? (
                      <TableRow>
                        <TableCell className="py-6 text-center text-muted-foreground" colSpan={3}>
                          {t("noStoresEmpty")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      stores.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <span>{s.name}</span>
                              <Badge size="sm" variant={s.source === "cloud" ? "success" : "secondary"}>
                                {s.source === "cloud" ? t("badgeCloud") : t("badgeLocal")}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums">{s.cameraIds.length}</TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1">
                              <Button
                                aria-label={t("editStoreAria", { name: s.name })}
                                onClick={() => onEditStore(s)}
                                size="icon-xs"
                                variant="ghost"
                              >
                                <PencilIcon aria-hidden="true" />
                              </Button>
                              {s.roomId !== "other" && (
                                <Button
                                  aria-label={t("deleteStoreAria", { name: s.name })}
                                  onClick={() => setDeleteTarget(s)}
                                  size="icon-xs"
                                  variant="ghost"
                                >
                                  <Trash2Icon aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>

                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>{t("cameraMappingTitle", { count: cameras.length })}</span>
                </div>

                <Table variant="card">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colCamera")}</TableHead>
                      <TableHead>{t("colStore")}</TableHead>
                      <TableHead>{t("colCloudAlias")}</TableHead>
                      <TableHead className="w-24 text-right">{t("colConfigure")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cameras.map((cam) => {
                      const st = findCameraStore(stores, cam.deviceId);
                      return (
                        <TableRow key={cam.deviceId}>
                          <TableCell className="font-medium">{cameraLabel(cam)}</TableCell>
                          <TableCell>
                            {st ? (
                              <Badge variant="outline">{st.name}</Badge>
                            ) : (
                              <span className="text-muted-foreground">{t("filterUnassigned")}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{cam.alias}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              onClick={() => onEditCamera(cam)}
                              size="xs"
                              variant="outline"
                            >
                              {t("changeButton")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TabsPanel>

              {/* Tab 3: Hidden Technical Diagnostics & Relay Logs */}
              <TabsPanel className="flex flex-col gap-4" value="diagnostics">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ActivityIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span>{t("telemetryTitle")}</span>
                </div>

                <Table variant="card">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colCamera")}</TableHead>
                      <TableHead>{t("colModelFw")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead>{t("colStream")}</TableHead>
                      <TableHead className="text-right">{t("colKbps")}</TableHead>
                      <TableHead className="text-right">{t("colPing")}</TableHead>
                      <TableHead className="text-right">{t("colReconnects")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cameras.map((cam) => {
                      const camTelemetry = telemetry[cam.deviceId];
                      const meta = relayStatusMeta(
                        isCameraOnline(cam, camTelemetry) ? camTelemetry?.status : "offline",
                        lang,
                      );
                      return (
                        <TableRow key={cam.deviceId}>
                          <TableCell className="font-medium">{cameraLabel(cam)}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {cam.deviceModel} {cam.deviceHwVer} · {cam.fwVer.split(" ")[0]}
                          </TableCell>
                          <TableCell>
                            <Badge variant={meta.badgeVariant}>{meta.label}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {camTelemetry && camTelemetry.mode !== "off"
                              ? `${camTelemetry.resolution} · ${camTelemetry.mode}`
                              : "idle"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {camTelemetry?.kbps ?? 0}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {camTelemetry?.connectLatencyMs ? `${camTelemetry.connectLatencyMs}ms` : "—"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {camTelemetry?.reconnects ?? 0}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>

                <div className="flex items-center gap-2 text-sm font-medium">
                  <ServerIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span>{t("relayLogsTitle")}</span>
                </div>

                <ScrollArea className="h-48 rounded-xl border bg-muted/20 p-3">
                  {logs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("noLogsYet")}</p>
                  ) : (
                    <div className="flex flex-col gap-1 font-mono text-xs">
                      {logs.map((entry) => (
                        <div className="flex items-start gap-2" key={entry.id}>
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {formatTsTime(entry.ts, lang)}
                          </span>
                          <span
                            className={cn(
                              entry.level === "error"
                                ? "text-destructive-foreground"
                                : entry.level === "warn"
                                  ? "text-warning-foreground"
                                  : "text-foreground/90",
                            )}
                          >
                            {formatRelayLog(entry, lang)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </TabsPanel>

              {/* Tab 4: Account Management */}
              <TabsPanel className="flex flex-col gap-4" value="account">
                <Card>
                  <CardPanel className="flex flex-col gap-4 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {t("accountProviderLabel")}
                        </span>
                        <span className="text-sm font-semibold">{auth.email}</span>
                      </div>
                      <Badge variant="success">
                        <ShieldCheckIcon aria-hidden="true" />
                        <span>{t("terminalBound", { region: auth.regionCode })}</span>
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        disabled={refreshing}
                        loading={refreshing}
                        onClick={() => {
                          setRefreshing(true);
                          void onRefreshCameras().finally(() => setRefreshing(false));
                        }}
                        variant="outline"
                      >
                        <RefreshCwIcon aria-hidden="true" />
                        <span>{t("syncFromCloud")}</span>
                      </Button>

                      {accessRequired && onLock && (
                        <Button
                          disabled={locking}
                          loading={locking}
                          onClick={() => {
                            setLocking(true);
                            void onLock().finally(() => setLocking(false));
                          }}
                          variant="outline"
                        >
                          <LockIcon aria-hidden="true" />
                          <span>{t("lockDashboard")}</span>
                        </Button>
                      )}

                      <Button
                        onClick={() => setLogoutOpen(true)}
                        variant="destructive-outline"
                      >
                        <LogOutIcon aria-hidden="true" />
                        <span>{t("logoutButton")}</span>
                      </Button>
                    </div>
                  </CardPanel>
                </Card>

                <Card>
                  <CardPanel className="flex flex-col gap-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5">
                        <ArrowUpCircleIcon
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        />
                        <div className="flex flex-col gap-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-sm">{t("updateCardTitle")}</span>
                            <Badge size="sm" variant="secondary">
                              {capabilities?.desktopApp
                                ? t("updateModeDesktop")
                                : t("updateModeServer")}
                            </Badge>
                          </div>
                          <span className="text-muted-foreground text-xs">
                            {t("updateCurrentVersion", {
                              version:
                                updateState?.currentVersion ?? capabilities?.appVersion ?? "0.2.0",
                            })}
                          </span>
                        </div>
                      </div>

                      {(() => {
                        const phase = updateState?.phase ?? "idle";
                        if (phase === "up-to-date") {
                          return <Badge variant="success">{t("updateStatusUpToDate")}</Badge>;
                        }
                        if (phase === "available") {
                          return (
                            <Badge variant="info">
                              {t("updateStatusAvailable", {
                                version: updateState?.latestVersion ?? "",
                              })}
                            </Badge>
                          );
                        }
                        if (phase === "downloading") {
                          const label =
                            typeof updateState?.progress === "number"
                              ? t("updateStatusDownloadingPct", {
                                  pct: Math.round(updateState.progress),
                                })
                              : t("updateStatusDownloading");
                          return <Badge variant="warning">{label}</Badge>;
                        }
                        if (phase === "ready") {
                          return (
                            <Badge variant="success">
                              {t("updateStatusReady", {
                                version: updateState?.latestVersion ?? "",
                              })}
                            </Badge>
                          );
                        }
                        if (phase === "applying") {
                          return <Badge variant="warning">{t("updateStatusApplying")}</Badge>;
                        }
                        if (phase === "checking") {
                          return <Badge variant="secondary">{t("updateStatusChecking")}</Badge>;
                        }
                        if (phase === "error") {
                          return <Badge variant="error">{t("updateStatusError")}</Badge>;
                        }
                        return <Badge variant="outline">{t("updateStatusIdle")}</Badge>;
                      })()}
                    </div>

                    {updateState?.phase === "downloading" && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-300"
                          style={{
                            width: `${Math.max(6, Math.min(100, Math.round(updateState.progress ?? 0)))}%`,
                          }}
                        />
                      </div>
                    )}

                    {updateState?.phase === "error" && updateState.error && (
                      <Alert variant="error">
                        <AlertTriangleIcon aria-hidden="true" />
                        <AlertTitle>{t("updateStatusError")}</AlertTitle>
                        <AlertDescription>{updateState.error}</AlertDescription>
                      </Alert>
                    )}

                    {!capabilities?.desktopApp &&
                      (updateState?.phase === "available" || updateState?.phase === "ready") && (
                        <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2">
                          <span className="font-medium text-muted-foreground text-xs">
                            {t("updateDockerHint")}
                          </span>
                          <code className="select-all font-mono text-xs">
                            docker compose pull &amp;&amp; docker compose up -d
                          </code>
                        </div>
                      )}

                    <div className="flex flex-wrap items-center gap-2">
                      {onCheckUpdates && (
                        <Button
                          disabled={
                            checkingUpdates ||
                            applyingUpdate ||
                            updateState?.phase === "checking" ||
                            updateState?.phase === "downloading" ||
                            updateState?.phase === "applying"
                          }
                          loading={checkingUpdates || updateState?.phase === "checking"}
                          onClick={() => {
                            setCheckingUpdates(true);
                            void onCheckUpdates().finally(() => setCheckingUpdates(false));
                          }}
                          variant="outline"
                        >
                          <RefreshCwIcon aria-hidden="true" />
                          <span>{t("updateCheckButton")}</span>
                        </Button>
                      )}

                      {updateState?.canAutoUpdate &&
                        (updateState.phase === "available" || updateState.phase === "ready") &&
                        onApplyUpdate && (
                          <Button
                            disabled={applyingUpdate || checkingUpdates}
                            loading={applyingUpdate}
                            onClick={() => {
                              setApplyingUpdate(true);
                              void onApplyUpdate().finally(() => setApplyingUpdate(false));
                            }}
                            variant="default"
                          >
                            <DownloadIcon aria-hidden="true" />
                            <span>{t("updateInstallButton")}</span>
                          </Button>
                        )}

                      {updateState?.releaseUrl && (
                        <Button
                          render={
                            <a href={updateState.releaseUrl} rel="noreferrer" target="_blank" />
                          }
                          variant="ghost"
                        >
                          <ExternalLinkIcon aria-hidden="true" />
                          <span>{t("updateOpenRelease")}</span>
                        </Button>
                      )}
                    </div>
                  </CardPanel>
                </Card>
              </TabsPanel>
            </Tabs>
          </DialogPanel>

          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>{t("close")}</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleteTarget(null);
        }}
        open={Boolean(deleteTarget)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteStoreTitle", { name: deleteTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("deleteStoreDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button disabled={deletingStore} variant="ghost" />}>
              {t("cancel")}
            </AlertDialogClose>
            <Button
              disabled={deletingStore}
              loading={deletingStore}
              onClick={() => void confirmDeleteStore()}
              variant="destructive"
            >
              {t("deleteStoreConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog onOpenChange={setLogoutOpen} open={logoutOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("logoutTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("logoutDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button disabled={loggingOut} variant="ghost" />}>
              {t("cancel")}
            </AlertDialogClose>
            <Button
              disabled={loggingOut}
              loading={loggingOut}
              onClick={() => void confirmLogout()}
              variant="destructive"
            >
              {t("logoutConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
