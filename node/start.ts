/**
 * Dựng và chạy server tự chạy: SQLite + thư mục sách trong dataDir, trang tĩnh từ publicDir, cron mỗi giờ.
 * Dùng chung cho bản Docker / Node (main.ts) và bản tải về một file (desktop.ts).
 */
import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
export const SELF_HOST_DEFAULTS: Record<string, string> = {
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

/** Mặc định → mặc định riêng của từng bản → biến môi trường (thắng cuối). */
export function workerVars(extraDefaults: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...SELF_HOST_DEFAULTS, ...extraDefaults };
  for (const k of WORKER_VARS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function parseTrustProxy(v: string | undefined): TrustProxy {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "cloudflare") return "cloudflare";
  return t === "1" || t === "true" ? "1" : "";
}

export interface StartOptions {
  dataDir: string;
  publicDir: string;
  port: number;
  host: string;
  vars: Record<string, string>;
  trustProxy: TrustProxy;
  publicUrl?: string;
}

export interface RunningApp {
  server: Server;
  stop(): Promise<void>;
}

/** Lên server; cổng bận hay lỗi lúc listen thì reject (đã đóng DB). */
export async function startApp(o: StartOptions): Promise<RunningApp> {
  installRuntime();
  if (o.publicUrl) new URL(o.publicUrl); // sai định dạng thì dừng ngay lúc khởi động
  mkdirSync(o.dataDir, { recursive: true });
  const db = new SqliteD1(join(o.dataDir, "xteinklover.db"));
  const kv = await DirKV.open(join(o.dataDir, "books"));
  const assets = createAssets(o.publicDir, { connectSrc: o.vars.DEVICE_PUSH === "1" ? "http:" : undefined });
  const env = { ...o.vars, DB: db.asD1(), BOOKS: kv.asKV(), ASSETS: assets } as unknown as Env;
  const pending = new Set<Promise<unknown>>();

  const handler = createNodeHandler({ worker, env, trustProxy: o.trustProxy, publicUrl: o.publicUrl, maxBodyBytes: 100 * MB }, pending);
  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = 10 * 60 * 1000; // tải lên file 20 MB qua mạng chậm

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(o.port, o.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    db.close();
    throw e;
  }

  // Cron của worker (dọn phiên hết hạn, file chờ xóa, mã KOReader): chạy sau khi lên 1 phút, rồi mỗi giờ
  const cron = () => {
    const controller = { cron: "15 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController;
    Promise.resolve(worker.scheduled?.(controller, env, createContext(pending))).catch((e) => console.error("cron", e));
  };
  const first = setTimeout(cron, 60 * 1000);
  const every = setInterval(cron, HOUR);

  let stopped = false;
  return {
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      server.close();
      server.closeIdleConnections();
      await Promise.allSettled([...pending]);
      db.close();
    },
  };
}

/** Tắt êm khi Ctrl+C / docker stop: chờ việc nền xong, đóng DB. */
export function stopOnSignals(app: RunningApp): void {
  const stop = () => void app.stop().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
