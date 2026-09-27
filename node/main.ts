/**
 * Xteink Lover tự chạy (Docker / Node ≥ 22.16), không cần Cloudflare. Cùng code worker trong src/, chỉ thay nền:
 * D1 → SQLite (DATA_DIR/xteinklover.db), KV → thư mục (DATA_DIR/books), Assets → public/, cron → hẹn giờ.
 * Cấu hình bằng biến môi trường: mọi biến của worker (SIGNUP_CODE, MAX_USERS, …) cộng PORT, HOST, DATA_DIR,
 * TRUST_PROXY, PUBLIC_URL. Xem README, phần "Tự chạy bằng Docker".
 */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { installRuntime } from "./runtime";
import worker from "../src/index";
import type { Env } from "../src/env";
import { createAssets } from "./assets";
import { SqliteD1 } from "./d1";
import { DirKV } from "./kv";
import { createContext, createNodeHandler, type TrustProxy } from "./server";

const HOUR = 60 * 60 * 1000;
const MB = 1024 * 1024;

/**
 * Trần mặc định của bản Cloudflare đặt theo gói miễn phí (KV 1 GB, 1.000 ghi/ngày). Tự chạy thì ổ đĩa là của mình:
 * nới ra, vẫn giữ để một tài khoản lỗi không lấp đầy ổ. Đặt biến môi trường thì biến đó thắng.
 */
const SELF_HOST_DEFAULTS: Record<string, string> = {
  CATALOG_TITLE: "Xteink Lover",
  MAX_USERS: "1",
  // Server nằm trong mạng nhà: web chép thẳng sách vào thư mục theo tầng trên máy đọc
  DEVICE_PUSH: "1",
  MAX_STORAGE_MB_PER_USER: "5000",
  MAX_STORAGE_MB_TOTAL: "20000",
  MAX_UPLOADS_PER_DAY: "300",
  MAX_UPLOADS_PER_DAY_TOTAL: "5000",
};

/** Chỉ chuyển các biến worker dùng (khớp src/env.ts), không đưa cả process.env vào. */
const WORKER_VARS = [
  "CATALOG_TITLE", "MAX_UPLOAD_MB", "MAX_USERS", "SIGNUP_CODE", "OPEN_SIGNUP", "MAX_SIGNUPS_PER_DAY", "MAX_BOOKS_PER_USER",
  "MAX_STORAGE_MB_PER_USER", "MAX_STORAGE_MB_TOTAL", "MAX_UPLOADS_PER_DAY", "MAX_UPLOADS_PER_DAY_TOTAL",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_URL", "GOOGLE_BOOKS_KEY", "SHOW_SELF_HOST", "DEVICE_PUSH", "FETCH_ALLOW_LOCAL",
  "MAX_SYNC_DOCS", "MAX_SYNC_NEW_PER_DAY", "MAX_SYNC_WRITES_PER_DAY", "MAX_SYNC_WRITES_PER_DAY_TOTAL",
] as const satisfies readonly (keyof Env)[];

function workerVars(): Record<string, string> {
  const out: Record<string, string> = { ...SELF_HOST_DEFAULTS };
  for (const k of WORKER_VARS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function trustProxy(v: string | undefined): TrustProxy {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "cloudflare") return "cloudflare";
  return t === "1" || t === "true" ? "1" : "";
}

async function main(): Promise<void> {
  installRuntime();
  const here = fileURLToPath(new URL(".", import.meta.url));
  const dataDir = resolve(process.env.DATA_DIR || "data");
  const publicDir = resolve(process.env.PUBLIC_DIR || join(here, "..", "public"));
  mkdirSync(dataDir, { recursive: true });

  const db = new SqliteD1(join(dataDir, "xteinklover.db"));
  const kv = await DirKV.open(join(dataDir, "books"));
  const vars = workerVars();
  const env = { ...vars, DB: db.asD1(), BOOKS: kv.asKV(), ASSETS: createAssets(publicDir, { connectSrc: vars.DEVICE_PUSH === "1" ? "http:" : undefined }) } as unknown as Env;
  const pending = new Set<Promise<unknown>>();
  const publicUrl = process.env.PUBLIC_URL?.trim() || undefined;
  if (publicUrl) new URL(publicUrl); // sai định dạng thì dừng ngay lúc khởi động

  const handler = createNodeHandler({ worker, env, trustProxy: trustProxy(process.env.TRUST_PROXY), publicUrl, maxBodyBytes: 100 * MB }, pending);
  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = 10 * 60 * 1000; // tải lên file 20 MB qua mạng chậm

  // Cron của worker (dọn phiên hết hạn, file chờ xóa, mã KOReader): chạy sau khi lên 1 phút, rồi mỗi giờ
  const cron = () => {
    const controller = { cron: "15 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController;
    Promise.resolve(worker.scheduled?.(controller, env, createContext(pending))).catch((e) => console.error("cron", e));
  };
  const first = setTimeout(cron, 60 * 1000);
  const every = setInterval(cron, HOUR);

  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`Xteink Lover đang chạy: http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (dữ liệu: ${dataDir})`);
    if (!vars.SIGNUP_CODE && vars.OPEN_SIGNUP !== "1") console.log("Chưa đặt SIGNUP_CODE: chưa ai đăng ký được. Đặt SIGNUP_CODE rồi chạy lại.");
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(first);
    clearInterval(every);
    server.close();
    server.closeIdleConnections();
    await Promise.allSettled([...pending]);
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
