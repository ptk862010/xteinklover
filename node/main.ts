/**
 * Xteink Lover tự chạy (Docker / Node ≥ 22.16), không cần Cloudflare. Cùng code worker trong src/, chỉ thay nền:
 * D1 → SQLite (DATA_DIR/xteinklover.db), KV → thư mục (DATA_DIR/books), Assets → public/, cron → hẹn giờ.
 * Cấu hình bằng biến môi trường: mọi biến của worker (SIGNUP_CODE, MAX_USERS, …) cộng PORT, HOST, DATA_DIR,
 * TRUST_PROXY, PUBLIC_URL. Xem README, phần "Tự chạy bằng Docker".
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrustProxy, startApp, stopOnSignals, workerVars } from "./start";

async function main(): Promise<void> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const dataDir = resolve(process.env.DATA_DIR || "data");
  const vars = workerVars();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const app = await startApp({
    dataDir,
    publicDir: resolve(process.env.PUBLIC_DIR || join(here, "..", "public")),
    port,
    host,
    vars,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    publicUrl: process.env.PUBLIC_URL?.trim() || undefined,
  });
  console.log(`Xteink Lover đang chạy: http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (dữ liệu: ${dataDir})`);
  if (!vars.SIGNUP_CODE && vars.OPEN_SIGNUP !== "1") console.log("Chưa đặt SIGNUP_CODE: chưa ai đăng ký được. Đặt SIGNUP_CODE rồi chạy lại.");
  stopOnSignals(app);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
