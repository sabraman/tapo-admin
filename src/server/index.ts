import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startTapoServer } from "./app";
import { resolveRuntimeServerConfig } from "./config";

const config = resolveRuntimeServerConfig();
const rootDir = resolve(import.meta.dir, "..", "..");
const distClientDir = join(rootDir, "dist", "client");

let staticDir = config.staticDir;
let devHtmlRoute: unknown;
let development = false;

if (staticDir && existsSync(join(staticDir, "index.html"))) {
  // Use explicitly configured staticDir.
} else if (existsSync(join(distClientDir, "index.html"))) {
  staticDir = distClientDir;
} else if (process.env.NODE_ENV !== "production") {
  const devEntry = "../client/index.html";
  devHtmlRoute = (await import(devEntry)).default;
  development = true;
}

const running = startTapoServer({
  ...config,
  staticDir,
  devHtmlRoute,
  development,
});

const shutdown = () => {
  running.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Tapo Admin running at ${running.url}`);
