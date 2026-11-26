import type {
  CameraMeta,
  CameraOrientation,
  CameraTelemetry,
  NetworkKind,
  ResolvedLanguage,
  Store,
} from "../../shared/types";

export const SIM_DEVICE_PREFIX = "sim-cam-";
export const SIM_STORE_PREFIX = "sim-store-";
const STORAGE_KEY = "tapo-admin:debug-emulator:v1";

export type SimulatedCameraStatus = "online" | "offline" | "error";
export type SimulatedSceneKind =
  | "checkout"
  | "warehouse"
  | "entrance"
  | "hall"
  | "parking"
  | "server";

export interface EmulatedCamera {
  deviceId: string;
  name: string;
  model: "C200" | "C210" | "C310" | "C520WS";
  storeId: string | null;
  status: SimulatedCameraStatus;
  scene: SimulatedSceneKind;
  orientation?: CameraOrientation;
  createdAt: number;
}

export interface EmulatedStore {
  id: string;
  name: string;
  address: string;
  networkKind: NetworkKind;
  createdAt: number;
}

export type EmulatedVideoSource = "auto" | "synthetic" | string;

export interface EmulatedState {
  stores: EmulatedStore[];
  cameras: EmulatedCamera[];
  seq: number;
  videoSource?: EmulatedVideoSource;
}

export const EMPTY_EMULATED_STATE: EmulatedState = {
  stores: [],
  cameras: [],
  seq: 1,
  videoSource: "auto",
};

type StoreTemplate = { name: string; address: string; networkKind: NetworkKind };
type CameraTemplate = { name: string; model: EmulatedCamera["model"]; scene: SimulatedSceneKind };

const STORE_TEMPLATES: Record<ResolvedLanguage, ReadonlyArray<StoreTemplate>> = {
  en: [
    { name: "Atrium Mall", address: "14 Central Ave", networkKind: "wired" },
    { name: "Arbat Pickup", address: "29 Arbat St", networkKind: "wired" },
    { name: "South Warehouse", address: "Zone 3, Bldg B", networkKind: "wired" },
    { name: "East Coffee", address: "88 Mira Ave", networkKind: "4g-modem" },
    { name: "North Showroom", address: "45 North Blvd", networkKind: "wired" },
    { name: "Parking Gate", address: "Gate #2", networkKind: "4g-modem" },
    { name: "Flagship Hall", address: "12 Main St", networkKind: "wired" },
    { name: "Support Office", address: "Horizon BC, Fl. 4", networkKind: "wired" },
    { name: "Pickup Point", address: "7 Garden St", networkKind: "4g-modem" },
    { name: "West Darkstore", address: "19 West Ave", networkKind: "wired" },
    { name: "Terminal B", address: "61 East Hwy", networkKind: "wired" },
    { name: "Tech Lab", address: "8 Science Ln", networkKind: "wired" },
  ],
  ru: [
    { name: "ТЦ Атриум", address: "ул. Центральная, 14", networkKind: "wired" },
    { name: "ПВЗ Арбат", address: "ул. Арбат, 29", networkKind: "wired" },
    { name: "Склад Юг", address: "Промзона 3, корп. Б", networkKind: "wired" },
    { name: "Кофейня Восток", address: "пр-т Мира, 88", networkKind: "4g-modem" },
    { name: "Шоурум Север", address: "Ленинградский пр-т, 45", networkKind: "wired" },
    { name: "Паркинг КПП", address: "Въезд №2", networkKind: "4g-modem" },
    { name: "Флагман Зал", address: "Тверская, 12", networkKind: "wired" },
    { name: "Офис Поддержка", address: "БЦ Горизонт, эт. 4", networkKind: "wired" },
    { name: "Пункт Выдачи", address: "Садовая, 7", networkKind: "4g-modem" },
    { name: "Даркстор Запад", address: "Кутузовский, 19", networkKind: "wired" },
    { name: "Терминал Б", address: "Шоссе Энтузиастов, 61", networkKind: "wired" },
    { name: "Лаборатория", address: "Научный проезд, 8", networkKind: "wired" },
  ],
};

const CAMERA_TEMPLATES: Record<ResolvedLanguage, ReadonlyArray<CameraTemplate>> = {
  en: [
    { name: "Main Entrance", model: "C310", scene: "entrance" },
    { name: "Checkout #1", model: "C200", scene: "checkout" },
    { name: "Checkout #2", model: "C210", scene: "checkout" },
    { name: "Sales Floor", model: "C520WS", scene: "hall" },
    { name: "Warehouse Racks", model: "C200", scene: "warehouse" },
    { name: "Loading Bay", model: "C310", scene: "parking" },
    { name: "Reception", model: "C210", scene: "hall" },
    { name: "Server Room", model: "C200", scene: "server" },
    { name: "Storefront", model: "C520WS", scene: "entrance" },
  ],
  ru: [
    { name: "Входная группа", model: "C310", scene: "entrance" },
    { name: "Касса №1", model: "C200", scene: "checkout" },
    { name: "Касса №2", model: "C210", scene: "checkout" },
    { name: "Торговый зал", model: "C520WS", scene: "hall" },
    { name: "Склад стеллажи", model: "C200", scene: "warehouse" },
    { name: "Зона погрузки", model: "C310", scene: "parking" },
    { name: "Ресепшн", model: "C210", scene: "hall" },
    { name: "Серверная", model: "C200", scene: "server" },
    { name: "Витрина", model: "C520WS", scene: "entrance" },
  ],
};

export function isSimulatedCamera(deviceId: string): boolean {
  return deviceId.startsWith(SIM_DEVICE_PREFIX);
}

export function isSimulatedStore(storeId: string): boolean {
  return storeId.startsWith(SIM_STORE_PREFIX);
}

export function loadEmulatedState(): EmulatedState {
  if (typeof window === "undefined") return EMPTY_EMULATED_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_EMULATED_STATE;
    const parsed = JSON.parse(raw) as Partial<EmulatedState>;
    return {
      stores: Array.isArray(parsed.stores) ? parsed.stores : [],
      cameras: Array.isArray(parsed.cameras) ? parsed.cameras : [],
      seq: typeof parsed.seq === "number" && parsed.seq > 0 ? parsed.seq : 1,
      videoSource:
        typeof parsed.videoSource === "string" && parsed.videoSource.length > 0
          ? parsed.videoSource
          : "auto",
    };
  } catch {
    return EMPTY_EMULATED_STATE;
  }
}

export function saveEmulatedState(state: EmulatedState): void {
  if (typeof window === "undefined") return;
  try {
    if (state.stores.length === 0 && state.cameras.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function addEmulatedStore(
  state: EmulatedState,
  input: {
    name?: string;
    address?: string;
    networkKind?: NetworkKind;
    initialCameras?: number;
  },
  lang: ResolvedLanguage = "ru",
): { nextState: EmulatedState; createdStore: EmulatedStore } {
  let seq = state.seq;
  const templates = STORE_TEMPLATES[lang];
  const tpl = templates[(state.stores.length + seq) % templates.length]!;
  const storeId = `${SIM_STORE_PREFIX}${seq++}`;
  const trimmedName = input.name?.trim();
  const duplicateIndex =
    trimmedName ||
    state.stores.some((s) => s.name === tpl.name)
      ? ` #${state.stores.length + 1}`
      : "";

  const createdStore: EmulatedStore = {
    id: storeId,
    name: trimmedName || `${tpl.name}${duplicateIndex}`,
    address: input.address?.trim() || tpl.address,
    networkKind: input.networkKind ?? tpl.networkKind,
    createdAt: Date.now(),
  };

  let next: EmulatedState = {
    ...state,
    stores: [...state.stores, createdStore],
    cameras: [...state.cameras],
    seq,
  };

  const count = Math.max(0, Math.min(12, Math.trunc(input.initialCameras ?? 0)));
  for (let i = 0; i < count; i++) {
    next = addEmulatedCamera(next, { storeId: createdStore.id }, lang).nextState;
  }

  return { nextState: next, createdStore };
}

export function addEmulatedCamera(
  state: EmulatedState,
  input: {
    name?: string;
    model?: EmulatedCamera["model"];
    storeId?: string | null;
    status?: SimulatedCameraStatus;
    scene?: SimulatedSceneKind;
  },
  lang: ResolvedLanguage = "ru",
): { nextState: EmulatedState; createdCamera: EmulatedCamera } {
  const num = state.seq;
  const templates = CAMERA_TEMPLATES[lang];
  const tpl = templates[(state.cameras.length + num) % templates.length]!;
  const createdCamera: EmulatedCamera = {
    deviceId: `${SIM_DEVICE_PREFIX}${num}`,
    name: input.name?.trim() || `${tpl.name} ${num}`,
    model: input.model ?? tpl.model,
    storeId: input.storeId ?? null,
    status: input.status ?? "online",
    scene: input.scene ?? tpl.scene,
    createdAt: Date.now(),
  };

  return {
    nextState: {
      ...state,
      cameras: [...state.cameras, createdCamera],
      seq: num + 1,
    },
    createdCamera,
  };
}

export function updateEmulatedCamera(
  state: EmulatedState,
  deviceId: string,
  patch: Partial<Pick<EmulatedCamera, "name" | "storeId" | "status" | "model" | "scene" | "orientation">>,
): EmulatedState {
  return {
    ...state,
    cameras: state.cameras.map((cam) =>
      cam.deviceId === deviceId ? { ...cam, ...patch } : cam,
    ),
  };
}

export function deleteEmulatedCamera(state: EmulatedState, deviceId: string): EmulatedState {
  return {
    ...state,
    cameras: state.cameras.filter((cam) => cam.deviceId !== deviceId),
  };
}

export function deleteEmulatedStore(
  state: EmulatedState,
  storeId: string,
  removeAttachedCameras = false,
): EmulatedState {
  return {
    ...state,
    stores: state.stores.filter((st) => st.id !== storeId),
    cameras: removeAttachedCameras
      ? state.cameras.filter((cam) => cam.storeId !== storeId)
      : state.cameras.map((cam) =>
          cam.storeId === storeId ? { ...cam, storeId: null } : cam,
        ),
  };
}

export function updateEmulatedStore(
  state: EmulatedState,
  storeId: string,
  patch: Partial<Pick<EmulatedStore, "name" | "address" | "networkKind">>,
): EmulatedState {
  return {
    ...state,
    stores: state.stores.map((st) => (st.id === storeId ? { ...st, ...patch } : st)),
  };
}

export function applyEmulatedPreset(
  state: EmulatedState,
  cameraCount: number,
  groupCount: number,
  realStores: Store[],
  lang: ResolvedLanguage = "ru",
): EmulatedState {
  let seq = state.seq;
  const storeTemplates = STORE_TEMPLATES[lang];
  const camTemplates = CAMERA_TEMPLATES[lang];
  const newStores: EmulatedStore[] = [];
  for (let g = 0; g < groupCount; g++) {
    const tpl = storeTemplates[g % storeTemplates.length]!;
    const suffix = g >= storeTemplates.length ? ` ${Math.floor(g / storeTemplates.length) + 1}` : "";
    newStores.push({
      id: `${SIM_STORE_PREFIX}${seq++}`,
      name: `${tpl.name}${suffix}`,
      address: tpl.address,
      networkKind: tpl.networkKind,
      createdAt: Date.now() + g,
    });
  }

  const targetPools = newStores.length > 0 ? newStores.map((s) => s.id) : realStores.map((s) => s.id);
  const newCameras: EmulatedCamera[] = [];
  for (let c = 0; c < cameraCount; c++) {
    const tpl = camTemplates[c % camTemplates.length]!;
    const poolId = targetPools.length > 0 ? targetPools[c % targetPools.length]! : null;
    const status: SimulatedCameraStatus =
      c % 9 === 8 ? "offline" : c % 14 === 13 ? "error" : "online";
    newCameras.push({
      deviceId: `${SIM_DEVICE_PREFIX}${seq++}`,
      name: `${tpl.name} #${c + 1}`,
      model: tpl.model,
      storeId: poolId,
      status,
      scene: tpl.scene,
      createdAt: Date.now() + c,
    });
  }

  return {
    ...state,
    stores: newStores,
    cameras: newCameras,
    seq,
  };
}

export function setEmulatedVideoSource(
  state: EmulatedState,
  videoSource: EmulatedVideoSource,
): EmulatedState {
  return {
    ...state,
    videoSource,
  };
}

export function resolveMirrorSourceCamera(
  emulated: EmulatedState,
  realCameras: CameraMeta[],
  realTelemetry: Record<string, CameraTelemetry>,
  index = 0,
): CameraMeta | null {
  const mode = emulated.videoSource ?? "auto";
  if (mode === "synthetic" || realCameras.length === 0) return null;

  if (mode !== "auto") {
    const exact = realCameras.find((c) => c.deviceId === mode);
    if (exact) return exact;
  }

  const onlineReal = realCameras.filter((c) => {
    const t = realTelemetry[c.deviceId];
    if (t?.status === "offline") return false;
    return t?.status === "streaming" || c.rawStatus === 1 || c.accessPlatform === "IOT";
  });
  const pool = onlineReal.length > 0 ? onlineReal : realCameras;
  return pool[index % pool.length] ?? null;
}

export function setEmulatedCamerasMode(
  state: EmulatedState,
  mode: "all-online" | "mixed" | "all-offline",
): EmulatedState {
  return {
    ...state,
    cameras: state.cameras.map((cam, idx) => {
      if (mode === "all-online") return { ...cam, status: "online" };
      if (mode === "all-offline") return { ...cam, status: "offline" };
      const status: SimulatedCameraStatus =
        idx % 5 === 4 ? "offline" : idx % 11 === 10 ? "error" : "online";
      return { ...cam, status };
    }),
  };
}

export function mergeDashboardWithEmulator(
  realCameras: CameraMeta[],
  realStores: Store[],
  realTelemetry: Record<string, CameraTelemetry>,
  emulated: EmulatedState,
  lang: ResolvedLanguage = "ru",
): {
  cameras: CameraMeta[];
  stores: Store[];
  telemetry: Record<string, CameraTelemetry>;
} {
  if (emulated.cameras.length === 0 && emulated.stores.length === 0) {
    return {
      cameras: realCameras,
      stores: realStores,
      telemetry: realTelemetry,
    };
  }

  const extraByStore = new Map<string, string[]>();
  for (const cam of emulated.cameras) {
    if (!cam.storeId) continue;
    const list = extraByStore.get(cam.storeId) ?? [];
    list.push(cam.deviceId);
    extraByStore.set(cam.storeId, list);
  }

  const stores: Store[] = [
    ...realStores.map((st) => {
      const extra = extraByStore.get(st.id);
      if (!extra || extra.length === 0) return st;
      return { ...st, cameraIds: [...st.cameraIds, ...extra] };
    }),
    ...emulated.stores.map((st) => ({
      id: st.id,
      name: st.name,
      address: st.address,
      networkKind: st.networkKind,
      cameraIds: extraByStore.get(st.id) ?? [],
      createdAt: st.createdAt,
      source: "local" as const,
    })),
  ];

  const emulatedMetas: CameraMeta[] = emulated.cameras.map((cam, idx) => {
    const mirrorSource = resolveMirrorSourceCamera(emulated, realCameras, realTelemetry, idx);
    return {
      deviceId: cam.deviceId,
      alias: cam.name,
      customName: cam.name,
      cloudNickname: cam.name,
      orientation: cam.orientation ?? mirrorSource?.orientation,
      ...(mirrorSource ? { mirrorSourceDeviceId: mirrorSource.deviceId } : {}),
      deviceModel: cam.model,
      deviceName: `${cam.model} (Sim)`,
      deviceHwVer: "5.0",
      fwVer: "1.5.7-sim",
      deviceRegion: "eu-west-1",
      mac: `DE:B0:60:${String((idx + 10) % 99).padStart(2, "0")}:${String((idx * 7 + 11) % 99).padStart(2, "0")}:01`,
      accessPlatform: "SIMULATED",
      appServerUrl: "local://emulator",
      deviceType: "SMART.IPCAMERA",
      rawStatus: cam.status === "online" ? 1 : 0,
    };
  });

  const telemetry: Record<string, CameraTelemetry> = { ...realTelemetry };
  const now = Date.now();
  const simDropMsg =
    lang === "ru" ? "Эмуляция: обрыв потока (-71103)" : "Simulated stream drop (-71103)";
  emulated.cameras.forEach((cam, idx) => {
    telemetry[cam.deviceId] = {
      deviceId: cam.deviceId,
      status:
        cam.status === "online"
          ? "streaming"
          : cam.status === "error"
            ? "error"
            : "offline",
      mode: cam.status === "online" ? "grid_low" : "off",
      resolution: "VGA",
      gridFps: 15,
      subscribers: cam.status === "online" ? 1 : 0,
      audioSubscribers: 0,
      kbps: cam.status === "online" ? 360 + ((idx * 73) % 190) : 0,
      bytesTotal: cam.status === "online" ? (idx + 1) * 2_400_000 : 0,
      connectLatencyMs: cam.status === "online" ? 85 + ((idx * 19) % 110) : null,
      lastFrameAt: cam.status === "online" ? now : null,
      reconnects: cam.status === "error" ? 3 : 0,
      lastError: cam.status === "error" ? simDropMsg : null,
    };
  });

  return {
    cameras: [...realCameras, ...emulatedMetas],
    stores,
    telemetry,
  };
}
