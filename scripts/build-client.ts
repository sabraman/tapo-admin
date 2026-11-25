import { rmSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "bun-plugin-tailwind";

const rootDir = join(import.meta.dir, "..");
const outDir = join(rootDir, "dist", "client");

rmSync(outDir, { recursive: true, force: true });

const res = await Bun.build({
  entrypoints: [join(rootDir, "src", "client", "index.html")],
  outdir: outDir,
  plugins: [tailwindcss],
  minify: true,
});

for (const log of res.logs) {
  console.log(log);
}

if (!res.success) {
  console.error("Client build failed");
  process.exit(1);
}

console.log(`Built ${res.outputs.length} client file(s) into ${outDir}`);
