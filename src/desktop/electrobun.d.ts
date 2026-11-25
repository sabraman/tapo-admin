declare module "electrobun" {
  export type WindowsWebView2Permission =
    | "camera"
    | "microphone"
    | "geolocation"
    | "notifications";

  export interface ElectrobunConfig {
    app: {
      name: string;
      identifier: string;
      version: string;
      description?: string;
      urlSchemes?: string[];
      fileAssociations?: Array<{
        ext: string[];
        name: string;
        role?: "Editor" | "Viewer" | "Shell" | "None";
        icon?: string;
      }>;
    };
    build?: {
      mainProcess?: "bun" | "cottontail" | "zig" | "rust" | "go" | "odin";
      bun?: {
        entrypoint?: string;
        external?: string[];
        define?: Record<string, string>;
        alias?: Record<string, string>;
        minify?: boolean;
        sourcemap?: boolean | "inline" | "external" | "linked";
        target?: string | string[];
      };
      copy?: Record<string, string>;
      buildFolder?: string;
      artifactFolder?: string;
      watch?: string[];
      watchIgnore?: string[];
      mac?: {
        codesign?: boolean;
        createDmg?: boolean;
        notarize?: boolean;
        bundleCEF?: boolean;
        bundleWGPU?: boolean;
        defaultRenderer?: "native" | "cef";
        chromiumFlags?: Record<string, string | boolean>;
        entitlements?: Record<string, boolean | string | string[]>;
        icons?: string;
      };
      win?: {
        bundleCEF?: boolean;
        bundleWGPU?: boolean;
        defaultRenderer?: "native" | "cef";
        chromiumFlags?: Record<string, string | boolean>;
        autoGrantPermissions?: WindowsWebView2Permission[];
        icon?: string;
      };
      linux?: {
        bundleCEF?: boolean;
        bundleWGPU?: boolean;
        defaultRenderer?: "native" | "cef";
        chromiumFlags?: Record<string, string | boolean>;
        icon?: string;
      };
    };
    runtime?: {
      exitOnLastWindowClosed?: boolean;
      [key: string]: unknown;
    };
    scripts?: {
      preBuild?: string;
      postBuild?: string;
      postWrap?: string;
      postPackage?: string;
    };
    release?: {
      updateAuthority?: "direct" | "external" | "none";
      baseUrl?: string;
      generatePatch?: boolean;
    };
  }
}

declare module "electrobun/main" {
  export type ApplicationMenuItemConfig =
    | { type: "divider" | "separator" }
    | {
        type?: "normal";
        label?: string;
        tooltip?: string;
        action?: string;
        role?: string;
        data?: unknown;
        submenu?: ApplicationMenuItemConfig[];
        enabled?: boolean;
        checked?: boolean;
        hidden?: boolean;
        accelerator?: string;
      };

  export type MenuItemConfig =
    | { type: "divider" | "separator" }
    | {
        type?: "normal";
        label?: string;
        tooltip?: string;
        action?: string;
        data?: unknown;
        submenu?: MenuItemConfig[];
        enabled?: boolean;
        checked?: boolean;
        hidden?: boolean;
      };

  export interface WindowOptionsType {
    title: string;
    frame: { x?: number; y?: number; width: number; height: number };
    url: string | null;
    html: string | null;
    preload: string | null;
    viewsRoot: string | null;
    allowedProtocols: { views?: boolean; appData?: boolean };
    renderer: "native" | "cef";
    titleBarStyle: "hidden" | "hiddenInset" | "default";
    transparent: boolean;
    passthrough: boolean;
    spellCheck: boolean;
    hidden?: boolean;
    navigationRules: string | null;
    sandbox: boolean;
  }

  export class BrowserWindow {
    id: number;
    title: string;
    constructor(options?: Partial<WindowOptionsType>);
    setTitle(title: string): void;
    close(): void;
    requestClose(): void;
    activate(): void;
    show(): void;
    showInactive(): void;
    hide(): void;
    minimize(): void;
    unminimize(): void;
    maximize(): void;
    unmaximize(): void;
    setFullScreen(fullScreen: boolean): void;
    on(name: string, handler: (event: unknown) => void): void;
  }

  export interface TrayOptions {
    title?: string;
    image?: string;
    template?: boolean;
    width?: number;
    height?: number;
  }

  export class Tray {
    id: number;
    visible: boolean;
    constructor(options?: TrayOptions);
    setTitle(title: string): void;
    setImage(imgPath: string): void;
    setMenu(menu: MenuItemConfig[]): void;
    on(name: "tray-clicked", handler: (event: unknown) => void): void;
    setVisible(visible: boolean): void;
    remove(): void;
  }

  export const ApplicationMenu: {
    setApplicationMenu: (menu: ApplicationMenuItemConfig[]) => void;
    on: (name: "application-menu-clicked", handler: (event: unknown) => void) => void;
  };

  export interface BuildConfigType {
    defaultRenderer: "native" | "cef";
    availableRenderers: ("native" | "cef")[];
    channel: "dev" | "canary" | "stable";
    isPackaged: boolean;
    runtime?: {
      exitOnLastWindowClosed?: boolean;
      [key: string]: unknown;
    };
  }

  export const BuildConfig: {
    get: () => Promise<BuildConfigType>;
    getSync: () => BuildConfigType;
    getCached: () => BuildConfigType | null;
  };

  export const PATHS: {
    readonly RESOURCES_FOLDER: string;
    readonly VIEWS_FOLDER: string;
  };

  export interface UpdateStatusDetails {
    fromHash?: string;
    toHash?: string;
    currentHash?: string;
    latestHash?: string;
    patchNumber?: number;
    totalPatchesApplied?: number;
    progress?: number;
    bytesDownloaded?: number;
    totalBytes?: number;
    usedPatchPath?: boolean;
    errorMessage?: string;
    url?: string;
    zstdPath?: string;
    exitCode?: number | null;
  }

  export interface UpdateStatusEntry {
    status: string;
    message: string;
    timestamp: number;
    details?: UpdateStatusDetails;
  }

  export interface LocalUpdateInfo {
    version: string;
    hash: string;
    baseUrl: string;
    channel: string;
    name: string;
    displayName?: string;
    identifier: string;
    updateAuthority?: "direct" | "external" | "none";
  }

  export interface UpdateInfo {
    version: string;
    hash: string;
    updateAvailable: boolean;
    updateReady: boolean;
    error: string;
  }

  export const Updater: {
    updateInfo: () => UpdateInfo;
    getStatusHistory: () => UpdateStatusEntry[];
    clearStatusHistory: () => void;
    onStatusChange: (listener: ((entry: UpdateStatusEntry) => void) | null) => void;
    checkForUpdate: () => Promise<UpdateInfo>;
    downloadUpdate: () => Promise<void>;
    applyUpdate: () => Promise<void>;
    getLocalInfo: () => Promise<LocalUpdateInfo>;
    localInfo: {
      version: () => Promise<string>;
      hash: () => Promise<string>;
      channel: () => Promise<string>;
      baseUrl: () => Promise<string>;
    };
  };

  export interface NotificationOptions {
    title: string;
    body?: string;
    subtitle?: string;
    silent?: boolean;
  }

  export const Utils: {
    quit: (code?: number) => boolean;
    openExternal: (url: string) => boolean;
    openPath: (path: string) => boolean;
    showNotification: (options: NotificationOptions) => void;
    paths: {
      readonly home: string;
      readonly appData: string;
      readonly config: string;
      readonly cache: string;
      readonly temp: string;
      readonly logs: string;
      readonly documents: string;
      readonly downloads: string;
      readonly desktop: string;
      readonly pictures: string;
      readonly music: string;
      readonly videos: string;
      readonly userData: string;
      readonly userCache: string;
      readonly userLogs: string;
    };
  };

  const Electrobun: {
    events: {
      on: (name: string, handler: (...args: unknown[]) => void) => unknown;
      off: (name: string, handler: (...args: unknown[]) => void) => unknown;
    };
    BrowserWindow: typeof BrowserWindow;
    Tray: typeof Tray;
    Updater: typeof Updater;
    Utils: typeof Utils;
    ApplicationMenu: typeof ApplicationMenu;
    PATHS: typeof PATHS;
    BuildConfig: typeof BuildConfig;
  };

  export default Electrobun;
}
