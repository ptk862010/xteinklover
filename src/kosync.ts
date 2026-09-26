/**
 * Đồng bộ tiến độ đọc theo giao thức KOSync (plugin kosync của KOReader; firmware CrossPoint cũng dùng).
 * Máy đọc gọi thẳng các đường dẫn gốc /users/*, /syncs/* với header x-auth-user + x-auth-key = md5(mật khẩu gõ vào).
 *
 * Không dùng mật khẩu tài khoản (đã băm PBKDF2 hai tầng, không kiểm được từ md5) mà dùng "mã đồng bộ": mỗi máy một
 * mã 20 chữ số, tạo trên web, hiện một lần. Máy gửi md5 của đúng chuỗi gõ vào, nên lưu 3 bộ xác minh cho 3 cách gõ
 * (liền / cách dấu cách / gạch ngang), mỗi mã một salt riêng.
 *
 * Mấy điều khách hàng thật đòi hỏi (đã đối chiếu mã nguồn KOReader + CrossPoint):
 *  - Sách chưa có tiến độ → 200 {} (404 làm KOReader báo lỗi khi kéo tay; 5xx làm CrossPoint không bao giờ đẩy lên).
 *  - 401 chỉ khi sai mã thật: KOReader tự đẩy mà nhận 401 thì VỨT tiến độ, không xếp hàng. Lỗi D1 → 5xx.
 *  - timestamp là số nguyên, đơn vị GIÂY; progress là chuỗi, trả nguyên văn.
 *  - Không đòi Accept / Content-Type, không redirect, luôn trả JSON {code, message} khi lỗi.
 *  - CrossPoint gửi kèm Authorization: Basic với mã THÔ — không bao giờ log header.
 */
import { FRESH_LOGIN_MS, hasPassword, recheckPassword, utcDay } from "./accounts";
import { SessionAuth } from "./auth";
import { randomBytes, sha256Hex, timingSafeEqualStr, toHex } from "./crypto";
import * as db from "./db";
import { Env, limits } from "./env";
import { error, json, readJson } from "./http";
import { USERNAME_RE, cleanText, normalizeUsername } from "./validate";

/** Mã lỗi theo máy chủ gốc koreader-sync-server (config/errors.lua). */
export const KOSYNC_ERR = {
  SERVER: 2000,
  UNAUTHORIZED: 2001,
  INVALID: 2003,
  DOCUMENT: 2004,
  REGISTRATION_DISABLED: 2005,
  NOT_FOUND: 2008,
} as const;

/** Mã sách: md5 32 hex của KOReader; cho rộng hơn chút như máy chủ gốc. Cùng một luật cho PUT và GET. */
export const DOCUMENT_RE = /^[A-Za-z0-9_]{1,64}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
export const SYNC_CODE_DIGITS = 20;
export const MAX_SYNC_KEYS = 5;
const PROGRESS_MAX = 4096;
const DEVICE_MAX = 128;
/** Ghi "lần dùng cuối" tối đa mỗi giờ một lần (đỡ tốn lượt ghi D1). */
const TOUCH_EVERY_MS = 3600_000;

const enc = new TextEncoder();

export type Md5 = (s: string) => Promise<string>;

/** MD5 có sẵn trong WebCrypto của Workers (ngoài chuẩn, dành cho hệ thống cũ). Chỉ dùng lúc tạo mã. */
export const workersMd5: Md5 = async (s) => toHex(await crypto.subtle.digest("MD5", enc.encode(s)));

// ── mã đồng bộ ─────────────────────────────────────────

/** 20 chữ số ngẫu nhiên (~66 bit). Chỉ chữ số: bàn phím máy đọc hay tự viết hoa chữ đầu. */
export function newSyncCode(): string {
  let s = "";
  while (s.length < SYNC_CODE_DIGITS) {
    // Loại bias modulo: chỉ nhận byte < 250
    for (const b of randomBytes(SYNC_CODE_DIGITS * 2)) if (b < 250 && s.length < SYNC_CODE_DIGITS) s += String(b % 10);
  }
  return s;
}

/** 3 cách người ta gõ mã: liền, nhóm 4 cách dấu cách, nhóm 4 cách gạch ngang. */
export function codeVariants(code: string): [string, string, string] {
  const groups = code.match(/.{1,4}/g) ?? [code];
  return [code, groups.join(" "), groups.join("-")];
}

export async function makeVerifiers(code: string, saltHex: string, md5: Md5): Promise<{ v_plain: string; v_space: string; v_dash: string }> {
  const [plain, space, dash] = await Promise.all(codeVariants(code).map((v) => md5(v)));
  return {
    v_plain: await sha256Hex(saltHex + plain),
    v_space: await sha256Hex(saltHex + space),
    v_dash: await sha256Hex(saltHex + dash),
  };
}

/** x-auth-key (md5 hex, hoa/thường đều được) có khớp một trong 3 cách gõ của mã này không. So hằng thời gian. */
export async function keyMatches(key: string, row: Pick<db.SyncKeyRow, "salt" | "v_plain" | "v_space" | "v_dash">): Promise<boolean> {
  const k = key.toLowerCase();
  const got = await sha256Hex(row.salt + (KEY_RE.test(k) ? k : "x"));
  const a = timingSafeEqualStr(got, row.v_plain);
  const b = timingSafeEqualStr(got, row.v_space);
  const c = timingSafeEqualStr(got, row.v_dash);
  return KEY_RE.test(k) && (a || b || c);
}

// ── dữ liệu máy gửi lên ────────────────────────────────

export type ParsedProgress = { ok: true; value: db.SyncProgressIn } | { ok: false; code: number; message: string };

/**
 * Rộng rãi như máy chủ gốc: chỉ từ chối cái không cứu được (thiếu trường, sai kiểu). Phần trăm ngoài 0..1 thì kẹp
 * (CrossPoint không kẹp), tên máy dài thì cắt, trường lạ (metadata, position…) bỏ qua.
 */
export function parseProgress(body: Record<string, unknown> | null): ParsedProgress {
  const bad = (code: number, message: string): ParsedProgress => ({ ok: false, code, message });
  if (!body) return bad(KOSYNC_ERR.INVALID, "Invalid request");
  const { document, progress, percentage, device, device_id } = body;
  if (typeof document !== "string" || !DOCUMENT_RE.test(document)) return bad(KOSYNC_ERR.DOCUMENT, "Field 'document' not provided.");
  if (typeof progress !== "string" || progress.length === 0 || progress.length > PROGRESS_MAX) return bad(KOSYNC_ERR.INVALID, "Invalid request");
  const pct = typeof percentage === "number" ? percentage : typeof percentage === "string" && percentage.trim() !== "" ? Number(percentage) : NaN;
  if (!Number.isFinite(pct)) return bad(KOSYNC_ERR.INVALID, "Invalid request");
  if (typeof device !== "string") return bad(KOSYNC_ERR.INVALID, "Invalid request");
  const id = typeof device_id === "string" && device_id !== "" ? Array.from(device_id).slice(0, DEVICE_MAX).join("") : null;
  return {
    ok: true,
    value: { document, progress, percentage: Math.min(Math.max(pct, 0), 1), device: Array.from(device).slice(0, DEVICE_MAX).join(""), device_id: id },
  };
}

// ── trả lời kiểu KOSync ────────────────────────────────

function kjson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function kerr(status: number, code: number, message: string): Response {
  return kjson({ code, message }, status);
}

const unauthorized = () => kerr(401, KOSYNC_ERR.UNAUTHORIZED, "Sai tên đăng nhập hoặc mã đồng bộ / Wrong username or sync code");

export function isSyncPath(path: string): boolean {
  return path === "/healthcheck" || path === "/users" || path.startsWith("/users/") || path === "/syncs" || path.startsWith("/syncs/");
}

/** Hai đường không cần D1: trả trước ensureSchema. null = để kosync() xử lý. */
export function kosyncEarly(path: string, method: string, url: URL): Response | null {
  if (path === "/healthcheck" && method === "GET") return kjson({ state: "OK" });
  if (path === "/users/create" && method === "POST") {
    // KOReader chỉ chấp nhận 201/402 cho đăng ký và hiện `message`. Tài khoản chỉ tạo trên web (giữ mã mời, giới hạn người).
    return kerr(
      402,
      KOSYNC_ERR.REGISTRATION_DISABLED,
      `Tạo tài khoản và mã đồng bộ tại ${url.origin} / Create your account and sync code at ${url.origin}`,
    );
  }
  return null;
}

interface SyncAuth {
  user: db.UserRow;
  key: db.SyncKeyRow;
}

/** Dummy để tên không tồn tại / chưa có mã vẫn tốn một lần băm như tên thật. */
const DUMMY_KEY = { salt: "00".repeat(16), v_plain: "0".repeat(64), v_space: "0".repeat(64), v_dash: "0".repeat(64) };

/**
 * Header x-auth-user + x-auth-key. Lỗi D1 KHÔNG bị nuốt (để nổi lên thành 5xx): coi lỗi D1 là "sai mã" → 401 →
 * KOReader vứt tiến độ.
 */
async function authenticate(env: Env, req: Request): Promise<SyncAuth | null> {
  const username = normalizeUsername(req.headers.get("x-auth-user"));
  const key = (req.headers.get("x-auth-key") ?? "").toLowerCase();
  // Sai định dạng thì loại luôn, không tốn lượt đọc D1 (request rác hàng loạt không đốt quota)
  if (!USERNAME_RE.test(username) || !KEY_RE.test(key)) return null;
  const found = await db.getSyncAuth(env.DB, username);
  const keys = found?.keys ?? [];
  let hit: db.SyncKeyRow | null = null;
  // Luôn so đủ MAX_SYNC_KEYS lần: thời gian phản hồi không lộ tên có tồn tại hay có mấy mã
  for (let i = 0; i < MAX_SYNC_KEYS; i++) {
    const k = keys[i];
    if ((await keyMatches(key, k ?? DUMMY_KEY)) && k && !hit) hit = k;
  }
  return found && hit ? { user: found.user, key: hit } : null;
}

function touch(env: Env, ctx: ExecutionContext, a: SyncAuth): void {
  const now = Date.now();
  if (now - a.key.last_used > TOUCH_EVERY_MS) ctx.waitUntil(db.touchSyncKey(env.DB, a.key.id, a.user.id, now).catch(() => undefined));
}

/** /users/auth, /syncs/progress… (sau ensureSchema). Mọi đường/method không khớp → 404 JSON, không rơi xuống nhánh web. */
export async function kosync(req: Request, env: Env, ctx: ExecutionContext, path: string, method: string): Promise<Response> {
  const docMatch = path.match(/^\/syncs\/progress\/([^/]+)$/);
  const known = (path === "/users/auth" && method === "GET") || (path === "/syncs/progress" && method === "PUT") || (docMatch && method === "GET");
  if (!known) return kerr(404, KOSYNC_ERR.NOT_FOUND, "Not found");

  let document = "";
  if (docMatch) {
    try {
      document = decodeURIComponent(docMatch[1]);
    } catch {
      return kerr(404, KOSYNC_ERR.NOT_FOUND, "Not found");
    }
    if (!DOCUMENT_RE.test(document)) return kerr(404, KOSYNC_ERR.NOT_FOUND, "Not found");
  }

  const auth = await authenticate(env, req);
  if (!auth) return unauthorized();
  touch(env, ctx, auth);

  if (path === "/users/auth") return kjson({ authorized: "OK" });

  if (docMatch) {
    const row = await db.getSyncProgress(env.DB, auth.user.id, document);
    if (!row) return kjson({});
    const out: Record<string, unknown> = { document: row.document, percentage: row.percentage, progress: row.progress, device: row.device, timestamp: row.updated_at };
    if (row.device_id) out.device_id = row.device_id;
    return kjson(out);
  }

  // PUT /syncs/progress
  const body = await readJson(req);
  if (!body) return kerr(400, 103, "Invalid JSON");
  const parsed = parseProgress(body);
  if (!parsed.ok) return kerr(403, parsed.code, parsed.message);
  const p = parsed.value;
  const nowSec = Math.floor(Date.now() / 1000);
  const lim = limits(env);

  // Trần lượt ghi theo ngày (mỗi người + cả hệ thống): kiểm bằng lượt ĐỌC trước, quá trần thì không ghi gì.
  // 503 chứ không 401: KOReader nhận 401 sẽ vứt tiến độ, 5xx thì xếp hàng gửi lại.
  const day = utcDay();
  const writeKeys: [string, number][] = [
    [`sync:w:${auth.user.id}:${day}`, 86400],
    [`sync:wall:${day}`, 86400],
  ];
  const [usedUser, usedAll] = await db.peekAttempts(env.DB, writeKeys, nowSec);
  if ((lim.maxSyncWritesPerDay > 0 && usedUser >= lim.maxSyncWritesPerDay) || (lim.maxSyncWritesPerDayTotal > 0 && usedAll >= lim.maxSyncWritesPerDayTotal)) {
    return kerr(503, KOSYNC_ERR.SERVER, "Sync limit for today reached, try again tomorrow");
  }
  const counted = () => ctx.waitUntil(db.hitAttempts(env.DB, writeKeys, nowSec).catch(() => undefined));

  if (await db.updateSyncProgress(env.DB, auth.user.id, p, nowSec)) {
    counted();
    return kjson({ document: p.document, timestamp: nowSec });
  }

  // Sách mới: giới hạn theo ngày chỉ tính ở nhánh này (một lượt ghi D1 mỗi sách mới, không phải mỗi PUT)
  if (lim.maxSyncNewPerDay > 0) {
    const n = await db.hitAttempt(env.DB, `sync:new:${auth.user.id}:${utcDay()}`, nowSec, 86400);
    if (n > lim.maxSyncNewPerDay) return kerr(403, KOSYNC_ERR.INVALID, "Too many new documents today");
  }
  // false = mã vừa bị thu hồi / tài khoản vừa bị xóa giữa chừng
  if (!(await db.insertSyncProgress(env.DB, auth.user.id, p, nowSec, lim.maxSyncDocs))) return unauthorized();
  counted();
  return kjson({ document: p.document, timestamp: nowSec });
}

// ── API cho trang web (cookie phiên) ───────────────────

export async function listKeys(env: Env, auth: SessionAuth): Promise<Response> {
  const [keys, docs] = await Promise.all([db.listSyncKeys(env.DB, auth.user.id), db.syncDocCount(env.DB, auth.user.id)]);
  return json({
    keys: keys.map((k) => ({ id: k.id, name: k.name, created: k.created_at, lastUsed: k.last_used || null })),
    docs,
    max: MAX_SYNC_KEYS,
  });
}

/** Tạo mã = thêm một cách vào tài khoản, xác nhận như tạo mã ứng dụng: nhập lại mật khẩu, hoặc vừa đăng nhập Google. */
export async function createKey(req: Request, env: Env, auth: SessionAuth, url: URL, md5: Md5 = workersMd5): Promise<Response> {
  const body = await readJson(req);
  if (hasPassword(auth.user)) {
    const bad = await recheckPassword(env, auth, body?.proof);
    if (bad) return bad;
  } else if (Date.now() - auth.createdAt > FRESH_LOGIN_MS) {
    return json({ error: "Đăng nhập lại bằng Google để tạo mã", reauth: true }, 403);
  }
  const name = cleanText(body?.name, "Máy đọc", 40);
  const code = newSyncCode();
  const salt = toHex(randomBytes(16));
  const row: db.SyncKeyRow = { id: toHex(randomBytes(8)), user_id: auth.user.id, name, salt, ...(await makeVerifiers(code, salt, md5)), created_at: Date.now(), last_used: 0 };
  if (!(await db.insertSyncKey(env.DB, row, MAX_SYNC_KEYS))) return error(409, `Tối đa ${MAX_SYNC_KEYS} mã đồng bộ, thu hồi bớt mã cũ trước`);
  // Mã chỉ hiện một lần ở đây
  return json({ id: row.id, name, code, username: auth.user.username, server: url.origin }, 201);
}

export async function revokeKey(env: Env, auth: SessionAuth, id: string): Promise<Response> {
  return (await db.deleteSyncKey(env.DB, auth.user.id, id)) ? json({ ok: true }) : error(404, "Không có mã này");
}

export async function clearProgress(env: Env, auth: SessionAuth): Promise<Response> {
  await db.clearSyncProgress(env.DB, auth.user.id);
  return json({ ok: true });
}
