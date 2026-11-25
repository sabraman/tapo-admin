import indexHtml from "../client/index.html";
import { startTapoServer } from "./app";
import { resolveRuntimeServerConfig } from "./config";

const runtimeConfig = resolveRuntimeServerConfig();
const running = startTapoServer({
  ...runtimeConfig,
  devHtmlRoute: indexHtml,
  development: true,
});

const shutdown = () => {
  running.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Tapo Admin running at ${running.url}`);
