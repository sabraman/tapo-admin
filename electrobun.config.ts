import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

const githubServer = (process.env.GITHUB_SERVER_URL?.trim() || "https://github.com").replace(/\/+$/, "");
const githubRepo = process.env.GITHUB_REPOSITORY?.trim() || "sabraman/tapo-admin";
const releaseBaseUrl =
  process.env.ELECTROBUN_RELEASE_URL?.trim() || `${githubServer}/${githubRepo}/releases/latest/download`;
const generatePatch =
  process.env.ELECTROBUN_GENERATE_PATCH === "true" || process.env.CI === "true";

export default {
  app: {
    name: "Tapo Admin",
    identifier: "com.tapoadmin.app",
    version: pkg.version,
  },
  build: {
    bun: {
      entrypoint: "src/desktop/main.ts",
      external: [],
    },
    copy: {
      "dist/client": "views/client",
      "certs/tapo-cloud-roots.pem": "certs/tapo-cloud-roots.pem",
      "assets/tray-Template.png": "assets/tray-Template.png",
      "assets/tray.ico": "assets/tray.ico",
    },
    mac: {
      icons: "assets/icon.iconset",
      defaultRenderer: "native",
      bundleCEF: false,
      createDmg: true,
      codesign: Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
      notarize: Boolean(process.env.ELECTROBUN_APPLEID || process.env.ELECTROBUN_APPLEAPIKEY),
      entitlements: {
        "com.apple.security.device.audio-input": true,
      },
    },
    win: {
      icon: "assets/icon.ico",
      defaultRenderer: "native",
      bundleCEF: false,
      autoGrantPermissions: ["microphone"],
    },
    watchIgnore: ["dist/**", "build/**", "artifacts/**", ".data/**"],
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  scripts: {
    preBuild: "./scripts/electrobun/pre-build.ts",
    postWrap: "./scripts/electrobun/post-wrap.ts",
  },
  release: {
    baseUrl: releaseBaseUrl,
    generatePatch,
  },
} satisfies ElectrobunConfig;
