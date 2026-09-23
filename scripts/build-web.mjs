import esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename } from "node:path";

// Bộ chuyển đổi chạy trên trình duyệt. ESM + splitting: MOBI / PDF / CBZ thành chunk riêng,
// chỉ tải khi có người gửi đúng loại file đó.
rmSync("public/convert.js", { force: true }); // bản build cũ (một file)
const result = await esbuild.build({
  entryPoints: { convert: "web/convert.ts" },
  bundle: true,
  format: "esm",
  splitting: true,
  target: "es2022",
  minify: true,
  outdir: "public/convert",
  chunkNames: "chunk-[hash]",
  metafile: true,
  logLevel: "info",
});
// Xóa chunk cũ không còn dùng (không xóa cả thư mục: wrangler dev đang theo dõi nó)
const keep = new Set(Object.keys(result.metafile.outputs).map((p) => basename(p)));
for (const f of readdirSync("public/convert")) if (!keep.has(f)) rmSync(`public/convert/${f}`, { force: true });

// PDF.js: worker + wasm (JBIG2/JPEG2000 hay gặp trong PDF scan). Bỏ standard_fonts/cmaps (16 MB):
// PDF tiếng Việt gần như luôn nhúng font.
if (!existsSync("public/pdfjs/wasm")) mkdirSync("public/pdfjs/wasm", { recursive: true });
cpSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "public/pdfjs/pdf.worker.min.mjs");
for (const f of ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"]) cpSync(`node_modules/pdfjs-dist/wasm/${f}`, `public/pdfjs/wasm/${f}`);
