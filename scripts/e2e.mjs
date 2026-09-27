// Bật wrangler dev với state sạch, chạy test tích hợp, rồi tắt và dọn.
// `--node`: chạy cùng bộ test trên bản tự chạy (dist/server.mjs: SQLite + thư mục) thay cho wrangler dev.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
// `--desktop`: cùng bộ test trên file chạy một mình (npm run build:desktop → dist/desktop/xteinklover[.exe])
const DESKTOP = process.argv.includes("--desktop");
const NODE = DESKTOP || process.argv.includes("--node");
const DESKTOP_EXE = `dist/desktop/xteinklover${process.platform === "win32" ? ".exe" : ""}`;
const startedAt = new Date();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? "ok" : "up";
  } catch (e) {
    return e?.name === "TimeoutError" ? "up" : "down";
  }
}

// Cổng đang có server khác (lần chạy trước còn sót) → dừng, kẻo test chạy nhầm vào server cũ
if ((await probe()) !== "down") {
  console.error(`Cổng ${PORT} đang bận (wrangler dev cũ chưa tắt?). Tắt nó rồi chạy lại.`);
  process.exit(1);
}

// State sạch mỗi lần, để ở thư mục temp (ổ E: không cho Node xóa thư mục kiểu này)
const STATE = mkdtempSync(join(tmpdir(), "xteinklover-e2e-"));
const VARS = {
  SIGNUP_CODE: "",
  OPEN_SIGNUP: "1",
  MAX_USERS: "0",
  MAX_SIGNUPS_PER_DAY: "0",
  MAX_UPLOADS_PER_DAY: "200",
  MAX_STORAGE_MB_TOTAL: "1",
  // Google giả: tests/e2e/api.e2e.mjs mở token endpoint ở cổng 8798
  GOOGLE_CLIENT_ID: "e2e.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "e2e-secret",
  GOOGLE_TOKEN_URL: "http://127.0.0.1:8798/token",
  // Dán link: cho lấy trang từ trang báo giả ở 127.0.0.1:8797
  FETCH_ALLOW_LOCAL: "1",
};
const varArgs = Object.entries(VARS).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
// Gọi thẳng wrangler bằng node (không qua shell) để taskkill /T diệt được cả workerd con
const dev = NODE
  ? spawn(DESKTOP ? DESKTOP_EXE : process.execPath, DESKTOP ? [] : ["dist/server.mjs"], {
      stdio: ["ignore", "pipe", "pipe"],
      // TRUST_PROXY=cloudflare: test giả nhiều IP bằng header CF-Connecting-IP, như wrangler dev cho phép
      env: { ...process.env, ...VARS, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: STATE, TRUST_PROXY: "cloudflare", XL_NO_BROWSER: "1" },
    })
  : spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--port", String(PORT), "--persist-to", STATE, ...varArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });
const READY = NODE ? "đang chạy" : "Ready on";
const WHO = NODE ? "server" : "wrangler dev";
let log = "";
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    if (dev.exitCode !== null) throw new Error(`${WHO} đã thoát:\n` + log);
    if (log.includes(READY) && (await probe()) === "ok") return;
    await sleep(500);
  }
  throw new Error(`${WHO} không lên:\n` + log);
}

async function cleanup() {
  if (process.platform === "win32") {
    await new Promise((r) => spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", r));
    // wrangler tách workerd khỏi cây tiến trình → diệt thêm các workerd của repo này sinh ra từ lúc bắt đầu test
    const ps = `Get-CimInstance Win32_Process -Filter "Name='workerd.exe'" | Where-Object { $_.ExecutablePath -like '${process.cwd().replace(/'/g, "''")}*' -and $_.CreationDate -ge [datetime]'${startedAt.toISOString()}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    await new Promise((r) => spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }).on("exit", r));
  } else {
    dev.kill("SIGTERM");
  }
  await sleep(300);
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* temp, hệ điều hành tự dọn */
  }
}

let code = 1;
process.on("SIGINT", () => cleanup().then(() => process.exit(130)));
try {
  await waitReady();
  const t = spawn(process.execPath, ["--test", "tests/e2e/api.e2e.mjs"], { stdio: "inherit", env: { ...process.env, BASE: `http://127.0.0.1:${PORT}`, E2E_NODE: NODE ? "1" : "" } });
  code = await new Promise((res) => t.on("exit", res));
} catch (e) {
  console.error(e.message);
} finally {
  await cleanup();
  if (code !== 0) console.error(`\n--- ${WHO} log (cuối) ---\n` + log.slice(-4000));
}
process.exit(code ?? 1);
