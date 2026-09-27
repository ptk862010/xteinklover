/**
 * Bản tải về một file (Node SEA) cho Windows / macOS / Linux: nhấp đúp là server chạy trong cửa sổ dòng lệnh,
 * trình duyệt tự mở kệ. Đóng cửa sổ là tắt. Dữ liệu nằm trong thư mục dữ liệu của người dùng, không cần cài gì.
 * Trang tĩnh (public/) nhúng trong file chạy, lần đầu mỗi phiên bản thì giải ra thư mục dữ liệu.
 */
import "./quiet";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APP, dataDirFor, lanAddresses } from "./desktop-paths";
import { parseTrustProxy, startApp, stopOnSignals, workerVars } from "./start";

declare const BUILD_ID: string;
const PORT = Number(process.env.PORT || 8787);

type Sea = { isSea(): boolean; getAsset(key: string): ArrayBuffer };

function seaModule(): Sea | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require("node:sea") as Sea;
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

/** Giải public/ nhúng trong file chạy ra dataDir/app/<BUILD_ID>/ (một lần mỗi phiên bản), xóa bản cũ. */
function extractPublic(sea: Sea, dataDir: string): string {
  const base = join(dataDir, "app");
  const dir = join(base, BUILD_ID);
  if (!existsSync(join(dir, ".done"))) {
    rmSync(dir, { recursive: true, force: true });
    const files = JSON.parse(new TextDecoder().decode(sea.getAsset("manifest.json"))) as string[];
    for (const rel of files) {
      const out = join(dir, "public", ...rel.split("/"));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, new Uint8Array(sea.getAsset("public/" + rel)));
    }
    writeFileSync(join(dir, ".done"), BUILD_ID);
  }
  for (const old of existsSync(base) ? readdirSync(base) : []) if (old !== BUILD_ID) rmSync(join(base, old), { recursive: true, force: true });
  return join(dir, "public");
}

function openBrowser(url: string): void {
  if (process.env.XL_NO_BROWSER === "1") return;
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => undefined).unref();
  } catch {
    /* không mở được thì người dùng tự mở theo địa chỉ in ra */
  }
}

async function alreadyRunning(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthcheck`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Nhấp đúp mà lỗi thì cửa sổ đóng ngay, người dùng không kịp đọc: giữ lại một phút. */
function holdAndExit(code: number): void {
  console.log("\n(Cửa sổ tự đóng sau 60 giây, hoặc bấm Ctrl+C.)");
  setTimeout(() => process.exit(code), 60_000);
}

async function main(): Promise<void> {
  process.title = APP;
  const dataDir = dataDirFor();
  const sea = seaModule();
  const publicDir = sea ? extractPublic(sea, dataDir) : resolve(process.env.PUBLIC_DIR || "public");
  const local = `http://localhost:${PORT}`;
  try {
    const app = await startApp({
      dataDir,
      publicDir,
      port: PORT,
      host: process.env.HOST || "0.0.0.0",
      // Máy của riêng mình: một tài khoản, người mở đầu tiên đăng ký luôn không cần mã mời
      vars: workerVars({ OPEN_SIGNUP: "1" }),
      trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    });
    stopOnSignals(app);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      if (await alreadyRunning()) {
        console.log(`${APP} đã chạy sẵn ở ${local}. Mở trình duyệt…`);
        openBrowser(local);
        setTimeout(() => process.exit(0), 3000);
        return;
      }
      console.error(`Cổng ${PORT} đang bị chương trình khác dùng. Tắt chương trình đó, hoặc chạy với biến PORT khác.`);
      return holdAndExit(1);
    }
    throw e;
  }

  const lan = lanAddresses();
  console.log(`\n  ${APP} đang chạy. Đóng cửa sổ này là tắt.\n`);
  console.log(`  Kệ sách:        ${local}`);
  for (const ip of lan) console.log(`  Máy đọc (OPDS): http://${ip}:${PORT}/opds`);
  if (lan.length) console.log(`  Đồng bộ tiến độ: http://${lan[0]}:${PORT}`);
  console.log(`  Dữ liệu:        ${dataDir}\n`);
  if (process.platform === "win32") console.log("  Windows hỏi quyền mạng thì bấm Allow, để máy đọc vào được.\n");
  openBrowser(local);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  holdAndExit(1);
});
