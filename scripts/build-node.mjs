// Bản tự chạy (Docker / Node): gói node/main.ts + src/ thành một file dist/server.mjs, không cần node_modules lúc chạy.
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["node/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server.mjs",
  // Vài gói CommonJS gọi require() lúc chạy: dựng require cho bản ESM
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
