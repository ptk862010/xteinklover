// Bản tải về một file (Node SEA): gói node/desktop.ts + src/ thành CJS, nhúng public/ làm asset,
// bơm vào bản sao của chính file node đang chạy. Chạy trên hệ điều hành nào ra file cho hệ đó
// (GitHub Actions build Windows / macOS / Linux: .github/workflows/desktop.yml).
//   npm run build:desktop   →   dist/desktop/xteinklover(.exe)
import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const OUT = "dist/desktop";
const win = process.platform === "win32";
const mac = process.platform === "darwin";
const exe = join(OUT, win ? "xteinklover.exe" : "xteinklover");

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. public/ (đã chạy npm run build) → danh sách asset + mã phiên bản theo nội dung
const files = walk("public").map((p) => relative("public", p).split(sep).join("/")).sort();
const hash = createHash("sha256");
for (const f of files) hash.update(f).update(readFileSync(join("public", f)));
const buildId = hash.digest("hex").slice(0, 12);
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(files));

// 2. Server một file CommonJS (SEA chỉ chạy CJS)
await esbuild.build({
  entryPoints: ["node/desktop.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: join(OUT, "desktop.cjs"),
  define: { BUILD_ID: JSON.stringify(buildId) },
  logLevel: "warning",
});

// 3. Blob SEA
const assets = { "manifest.json": join(OUT, "manifest.json") };
for (const f of files) assets["public/" + f] = join("public", ...f.split("/"));
const config = join(OUT, "sea-config.json");
writeFileSync(config, JSON.stringify({ main: join(OUT, "desktop.cjs"), output: join(OUT, "sea.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

// 4. Bơm vào bản sao của node (macOS: gỡ chữ ký trước, ký ad-hoc sau)
copyFileSync(process.execPath, exe);
if (mac) execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
const postject = ["node_modules/postject/dist/cli.js", exe, "NODE_SEA_BLOB", join(OUT, "sea.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", "--overwrite"];
if (mac) postject.push("--macho-segment-name", "NODE_SEA");
execFileSync(process.execPath, postject, { stdio: "inherit" });
if (mac) execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });

for (const f of ["manifest.json", "desktop.cjs", "sea-config.json", "sea.blob"]) rmSync(join(OUT, f));
console.log(`\n${exe}  ${(statSync(exe).size / 1048576).toFixed(1)} MB  (node ${process.version}, public ${buildId})`);
