import { MIGRATIONS } from "./schema";

export interface UserRow {
  id: string;
  username: string;
  pass_hash: string;
  pass_salt: string;
  pass_iter: number;
  client_kdf: string;
  opds_key_hash: string;
  created_at: string;
  last_login: number;
}

export interface BookRow {
  id: string;
  user_id: string;
  title: string;
  author: string;
  size: number;
  added: string;
  blob_key: string;
}

/** Sách trả cho trình duyệt / OPDS: không lộ user_id, blob_key. */
export interface BookMeta {
  id: string;
  title: string;
  author: string;
  size: number;
  /** ISO 8601 */
  added: string;
}

export function toMeta(b: BookRow): BookMeta {
  return { id: b.id, title: b.title, author: b.author, size: b.size, added: b.added };
}

// ── schema ─────────────────────────────────────────────

let schemaDone = false;

/**
 * Tạo / nâng cấp bảng, một lần mỗi isolate. Chỉ nhớ trạng thái "đã xong" (không nhớ promise dở dang),
 * nên request bị hủy giữa chừng không làm treo các request sau.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaDone) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)").run();
  const row = await db.prepare("SELECT version FROM schema_meta WHERE id = 1").first<{ version: number }>();
  const version = row?.version ?? 0;
  if (version < MIGRATIONS.length) {
    const stmts = MIGRATIONS.slice(version).flat().map((s) => db.prepare(s));
    stmts.push(
      db
        .prepare("INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = MAX(version, excluded.version)")
        .bind(MIGRATIONS.length),
    );
    try {
      await db.batch(stmts); // một transaction: lỗi thì không đổi gì
    } catch (e) {
      // Isolate khác vừa nâng cấp xong (vd. ALTER TABLE trùng cột) → coi như đã xong
      const again = await db.prepare("SELECT version FROM schema_meta WHERE id = 1").first<{ version: number }>();
      if ((again?.version ?? 0) < MIGRATIONS.length) throw e;
    }
  }
  schemaDone = true;
}

// ── users ──────────────────────────────────────────────

export function getUserByName(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
}

export async function updateOpdsKey(db: D1Database, userId: string, keyHash: string): Promise<void> {
  await db.prepare("UPDATE users SET opds_key_hash = ? WHERE id = ?").bind(keyHash, userId).run();
}

// ── sessions ───────────────────────────────────────────

/** Số phiên tối đa mỗi người; đăng nhập thêm thì phiên cũ nhất bị bỏ. */
export const MAX_SESSIONS_PER_USER = 10;

/**
 * Thêm phiên mới, cắt bớt phiên cũ của người đó (đăng nhập liên tục không làm phình bảng; phiên vừa tạo
 * luôn được giữ) và ghi lần đăng nhập cuối.
 */
export async function createSession(db: D1Database, tokenHash: string, userId: string, expiresAt: number, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, userId, expiresAt),
    db
      .prepare(
        `DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?4 AND (expires_at <= ?2 OR token_hash NOT IN
           (SELECT token_hash FROM sessions WHERE user_id = ?1 AND token_hash != ?4 ORDER BY expires_at DESC LIMIT ?3))`,
      )
      .bind(userId, nowMs, MAX_SESSIONS_PER_USER - 1, tokenHash),
    db.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(nowMs, userId),
  ]);
}

/** Cộng 1 lần nhập lại mật khẩu sai cho phiên này; trả về số lần sai của phiên. */
export async function sessionRecheckFail(db: D1Database, tokenHash: string): Promise<number> {
  const r = await db
    .prepare("UPDATE sessions SET recheck_fails = recheck_fails + 1 WHERE token_hash = ? RETURNING recheck_fails")
    .bind(tokenHash)
    .first<{ recheck_fails: number }>();
  return r?.recheck_fails ?? Number.MAX_SAFE_INTEGER;
}

export async function sessionRecheckFails(db: D1Database, tokenHash: string): Promise<number> {
  const r = await db.prepare("SELECT recheck_fails FROM sessions WHERE token_hash = ?").bind(tokenHash).first<{ recheck_fails: number }>();
  return r?.recheck_fails ?? Number.MAX_SAFE_INTEGER;
}

/** Đổi mật khẩu, đăng xuất mọi phiên khác và thu hồi mọi mã ứng dụng trong một transaction (lộ mật khẩu thì đổi là sạch). */
export async function changePasswordAndRevoke(
  db: D1Database,
  userId: string,
  h: { hash: string; salt: string; iterations: number },
  keepTokenHash: string,
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ? WHERE id = ?").bind(h.hash, h.salt, h.iterations, userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(userId, keepTokenHash),
    db.prepare("DELETE FROM app_tokens WHERE user_id = ?").bind(userId),
    db.prepare("UPDATE sessions SET recheck_fails = 0 WHERE token_hash = ?").bind(keepTokenHash),
  ]);
}

// ── thiết bị quen (cookie đánh dấu trình duyệt đã từng đăng nhập đúng) ──

export const MAX_DEVICES_PER_USER = 20;

export async function isKnownDevice(db: D1Database, tokenHash: string, userId: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS ok FROM devices WHERE token_hash = ? AND user_id = ?").bind(tokenHash, userId).first<{ ok: number }>();
  return !!r;
}

export async function addDevice(db: D1Database, tokenHash: string, userId: string, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO devices (token_hash, user_id, created_at) VALUES (?, ?, ?)").bind(tokenHash, userId, nowMs),
    db
      .prepare(
        `DELETE FROM devices WHERE user_id = ?1 AND token_hash != ?3 AND token_hash NOT IN
           (SELECT token_hash FROM devices WHERE user_id = ?1 AND token_hash != ?3 ORDER BY created_at DESC LIMIT ?2)`,
      )
      .bind(userId, MAX_DEVICES_PER_USER - 1, tokenHash),
  ]);
}

export async function getSessionUser(db: D1Database, tokenHash: string, now: number): Promise<{ user: UserRow; expiresAt: number } | null> {
  const r = await db
    .prepare("SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
    .bind(tokenHash, now)
    .first<UserRow & { session_expires: number }>();
  if (!r) return null;
  const { session_expires, ...user } = r;
  return { user, expiresAt: session_expires };
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

/** Dọn phiên hết hạn (có index expires_at, chỉ đọc đúng số dòng cần xóa). */
export async function purgeSessions(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at <= ? LIMIT 200)").bind(nowMs).run();
}

/**
 * Việc theo lịch (cron): bộ đếm cũ hơn 2 ngày, và tài khoản rỗng bỏ hoang (không có sách, không đăng nhập
 * INACTIVE_DAYS ngày) — để tài khoản rác không chiếm chỗ MAX_USERS mãi.
 */
export const INACTIVE_DAYS = 14;

export async function cronCleanup(db: D1Database, nowMs: number): Promise<void> {
  const cutoff = nowMs - INACTIVE_DAYS * 86400_000;
  const stale = `SELECT id FROM users u WHERE u.last_login < ?1 AND NOT EXISTS (SELECT 1 FROM books b WHERE b.user_id = u.id) LIMIT 50`;
  await db.batch([
    db.prepare("DELETE FROM attempts WHERE window_start < ?").bind(Math.floor(nowMs / 1000) - 2 * 86400),
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${stale})`).bind(cutoff),
    db.prepare(`DELETE FROM devices WHERE user_id IN (${stale})`).bind(cutoff),
    db.prepare(`DELETE FROM identities WHERE user_id IN (${stale})`).bind(cutoff),
    db.prepare(`DELETE FROM app_tokens WHERE user_id IN (${stale})`).bind(cutoff),
    db.prepare(`DELETE FROM users WHERE id IN (${stale})`).bind(cutoff),
    db.prepare("DELETE FROM oauth_pending WHERE expires_at <= ?").bind(nowMs),
  ]);
}

// ── books ──────────────────────────────────────────────

/** Trần số sách liệt kê một lần (web). MAX_BOOKS_PER_USER bị kẹp theo số này. */
export const LIST_LIMIT = 500;

export async function listBooks(db: D1Database, userId: string, limit = LIST_LIMIT, offset = 0): Promise<BookRow[]> {
  const r = await db.prepare("SELECT * FROM books WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").bind(userId, limit, offset).all<BookRow>();
  return r.results;
}

export function getBook(db: D1Database, userId: string, id: string): Promise<BookRow | null> {
  return db.prepare("SELECT * FROM books WHERE id = ? AND user_id = ?").bind(id, userId).first<BookRow>();
}

export type InsertResult = "ok" | "shelf_full" | "store_full";

/**
 * Thêm sách chỉ khi còn chỗ — kệ của người đó (số cuốn, dung lượng) và kho chung (MAX_STORAGE_MB_TOTAL) —
 * kiểm và ghi trong CÙNG một câu lệnh nên gửi song song không vượt được. Trigger tự cộng dung lượng chung.
 * Tài khoản vừa bị xóa thì không thêm.
 */
export async function insertBookWithinQuota(db: D1Database, b: BookRow, maxBooks: number, maxBytes: number, maxTotal: number): Promise<InsertResult> {
  const r = await db
    .prepare(
      `INSERT INTO books (id, user_id, title, author, size, added, blob_key)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)
         AND (SELECT COUNT(*) FROM books WHERE user_id = ?2) < ?8
         AND (SELECT COALESCE(SUM(size), 0) FROM books WHERE user_id = ?2) + ?5 <= ?9
         AND (SELECT value FROM stats WHERE key = 'bytes') + ?5 <= ?10`,
    )
    .bind(b.id, b.user_id, b.title, b.author, b.size, b.added, b.blob_key, maxBooks, maxBytes, maxTotal)
    .run();
  if (r.meta.changes > 0) return "ok";
  const total = await db.prepare("SELECT value FROM stats WHERE key = 'bytes'").first<{ value: number }>();
  if (!total) {
    // Dòng thống kê bị mất (sửa DB tay): dựng lại từ dữ liệu thật, lần gửi sau sẽ chạy
    console.error("stats.bytes missing — rebuilding");
    await db
      .prepare(
        "INSERT OR IGNORE INTO stats (key, value) SELECT 'bytes', (SELECT COALESCE(SUM(size), 0) FROM books) + (SELECT COALESCE(SUM(size), 0) FROM pending_deletes)",
      )
      .run();
    return "store_full";
  }
  return total.value + b.size > maxTotal ? "store_full" : "shelf_full";
}

/**
 * Sau khi ghi KV: nếu dòng sách đã bị xóa trong lúc đang ghi (xóa sách / xóa tài khoản chen giữa),
 * đưa file vào hàng chờ xóa để không thành file mồ côi.
 */
export async function queueIfOrphan(db: D1Database, b: { id: string; blob_key: string; size: number }, nowMs: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO pending_deletes (blob_key, size, queued_at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = ?4)")
    .bind(b.blob_key, b.size, nowMs, b.id)
    .run();
}

/**
 * Gỡ sách khỏi kệ: chuyển file sang hàng chờ xóa và xóa dòng trong một transaction.
 * Trả về blob_key nếu xóa được (null nếu không có — kể cả khi request song song đã xóa trước).
 */
export async function takeBook(db: D1Database, userId: string, id: string, nowMs: number): Promise<string | null> {
  const [, del] = await db.batch<{ blob_key: string }>([
    db
      .prepare("INSERT OR IGNORE INTO pending_deletes (blob_key, size, queued_at) SELECT blob_key, size, ? FROM books WHERE id = ? AND user_id = ?")
      .bind(nowMs, id, userId),
    db.prepare("DELETE FROM books WHERE id = ? AND user_id = ? RETURNING blob_key").bind(id, userId),
  ]);
  return del.results[0]?.blob_key ?? null;
}

export interface Usage {
  books: number;
  bytes: number;
}

/** Số sách và tổng dung lượng trên kệ của một người. */
export async function userUsage(db: D1Database, userId: string): Promise<Usage> {
  const r = await db.prepare("SELECT COUNT(*) AS books, COALESCE(SUM(size), 0) AS bytes FROM books WHERE user_id = ?").bind(userId).first<Usage>();
  return r ?? { books: 0, bytes: 0 };
}

// ── attempts (chặn dò mật khẩu / spam đăng ký / đếm lượt gửi) ─────────

/**
 * Câu lệnh cộng 1 lần thử cho `key` trong cửa sổ `windowSec`, trả về số lần trong cửa sổ hiện tại.
 * Hết cửa sổ thì đếm lại từ 1. Nguyên tử: dùng giá trị trả về để quyết định chặn.
 */
export function hitAttemptStmt(db: D1Database, key: string, now: number, windowSec: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO attempts (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN attempts.window_start <= ?2 - ?3 THEN 1 ELSE attempts.count + 1 END,
         window_start = CASE WHEN attempts.window_start <= ?2 - ?3 THEN ?2 ELSE attempts.window_start END
       RETURNING count`,
    )
    .bind(key, now, windowSec);
}

export async function hitAttempt(db: D1Database, key: string, now: number, windowSec: number): Promise<number> {
  const r = await hitAttemptStmt(db, key, now, windowSec).first<{ count: number }>();
  return r?.count ?? 1;
}

/** Chạy nhiều hitAttempt (mỗi khóa một cửa sổ riêng) trong một lượt gọi D1; trả về số đếm theo đúng thứ tự. */
export async function hitAttempts(db: D1Database, items: [key: string, windowSec: number][], now: number): Promise<number[]> {
  const res = await db.batch<{ count: number }>(items.map(([k, w]) => hitAttemptStmt(db, k, now, w)));
  return res.map((r) => r.results[0]?.count ?? 1);
}

export async function peekAttempt(db: D1Database, key: string, now: number, windowSec: number): Promise<number> {
  const r = await db.prepare("SELECT count, window_start FROM attempts WHERE key = ?").bind(key).first<{ count: number; window_start: number }>();
  if (!r || r.window_start <= now - windowSec) return 0;
  return r.count;
}

export async function clearAttempt(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM attempts WHERE key = ?").bind(key).run();
}

/** Trả lại một lượt (khi thao tác đã giữ lượt nhưng thất bại / thành công không tính). */
export async function unhitAttempt(db: D1Database, key: string): Promise<void> {
  await db.prepare("UPDATE attempts SET count = MAX(count - 1, 0) WHERE key = ?").bind(key).run();
}

/** Đọc nhiều bộ đếm trong một lượt gọi D1 (chỉ đọc). */
export async function peekAttempts(db: D1Database, items: [key: string, windowSec: number][], now: number): Promise<number[]> {
  const res = await db.batch<{ count: number; window_start: number }>(
    items.map(([k]) => db.prepare("SELECT count, window_start FROM attempts WHERE key = ?").bind(k)),
  );
  return res.map((r, i) => {
    const row = r.results[0];
    return !row || row.window_start <= now - items[i][1] ? 0 : row.count;
  });
}

// ── xóa file KV trễ ────────────────────────────────────

/** Xóa file KV của một khóa cụ thể rồi bỏ khỏi hàng chờ. Lỗi thì để hàng chờ lo. */
export async function finishBlobDelete(db: D1Database, kv: KVNamespace, blobKey: string): Promise<void> {
  await kv.delete(blobKey);
  await db.prepare("DELETE FROM pending_deletes WHERE blob_key = ?").bind(blobKey).run();
}

/**
 * Xóa tối đa `limit` file đang chờ (mỗi request Worker free chỉ được ~50 lệnh D1/KV nên giữ nhỏ).
 * File nào xóa KV lỗi (thường là hết 1.000 lượt xóa/ngày) thì để lần sau.
 */
export async function drainBlobDeletes(db: D1Database, kv: KVNamespace, limit = 30): Promise<number> {
  const r = await db.prepare("SELECT blob_key FROM pending_deletes LIMIT ?").bind(limit).all<{ blob_key: string }>();
  const done: string[] = [];
  for (const { blob_key } of r.results) {
    try {
      await kv.delete(blob_key);
      done.push(blob_key);
    } catch {
      break;
    }
  }
  if (done.length) {
    await db.prepare(`DELETE FROM pending_deletes WHERE blob_key IN (${done.map(() => "?").join(",")})`).bind(...done).run();
  }
  return done.length;
}

// ── xóa tài khoản ──────────────────────────────────────

/** Xóa user + phiên + dòng sách trong một transaction; file KV được đưa vào hàng chờ xóa. */
export async function deleteUserCascade(db: D1Database, userId: string, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO pending_deletes (blob_key, size, queued_at) SELECT blob_key, size, ? FROM books WHERE user_id = ?").bind(nowMs, userId),
    db.prepare("DELETE FROM books WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM devices WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM identities WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM app_tokens WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

// ── đăng nhập bằng Google (identities, oauth_pending) ──

export async function identityUserId(db: D1Database, provider: string, subject: string): Promise<string | null> {
  const r = await db.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, subject).first<{ user_id: string }>();
  return r?.user_id ?? null;
}

export async function hasIdentity(db: D1Database, userId: string, provider: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS ok FROM identities WHERE user_id = ? AND provider = ?").bind(userId, provider).first<{ ok: number }>();
  return !!r;
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

/**
 * Gắn Google vào tài khoản đang đăng nhập. "taken": Google này đã thuộc tài khoản khác;
 * "already": tài khoản này đã gắn một Google khác (mỗi tài khoản một Google).
 */
export async function linkIdentity(db: D1Database, provider: string, subject: string, userId: string, nowMs: number): Promise<"ok" | "taken" | "already"> {
  try {
    const r = await db
      .prepare("INSERT INTO identities (provider, subject, user_id, created_at) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?3)")
      .bind(provider, subject, userId, nowMs)
      .run();
    return r.meta.changes > 0 ? "ok" : "taken";
  } catch (e) {
    if (!String(e).includes("UNIQUE")) throw e;
    return (await identityUserId(db, provider, subject)) ? "taken" : "already";
  }
}

export async function unlinkIdentity(db: D1Database, userId: string, provider: string): Promise<void> {
  await db.prepare("DELETE FROM identities WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}

export interface PendingRow {
  token_hash: string;
  provider: string;
  subject: string;
  suggest: string;
  expires_at: number;
}

/** Giữ chỗ chọn tên; đồng thời dọn các chỗ đã hết hạn (bảng luôn nhỏ). */
export async function putPending(db: D1Database, p: PendingRow, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM oauth_pending WHERE expires_at <= ? OR (provider = ? AND subject = ?)").bind(nowMs, p.provider, p.subject),
    db
      .prepare("INSERT INTO oauth_pending (token_hash, provider, subject, suggest, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(p.token_hash, p.provider, p.subject, p.suggest, p.expires_at),
  ]);
}

export function getPending(db: D1Database, tokenHash: string, nowMs: number): Promise<PendingRow | null> {
  return db.prepare("SELECT * FROM oauth_pending WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, nowMs).first<PendingRow>();
}

/** Tên đầu tiên trong danh sách chưa có ai dùng (một lượt đọc D1). */
export async function firstFreeUsername(db: D1Database, candidates: string[]): Promise<string | null> {
  if (!candidates.length) return null;
  const r = await db
    .prepare(`SELECT username FROM users WHERE username IN (${candidates.map(() => "?").join(",")})`)
    .bind(...candidates)
    .all<{ username: string }>();
  const taken = new Set(r.results.map((x) => x.username));
  return candidates.find((c) => !taken.has(c)) ?? null;
}

// ── mã cho ứng dụng (app_tokens) ──

export interface AppTokenRow {
  id: string;
  token_hash: string;
  user_id: string;
  name: string;
  created_at: number;
  last_used: number;
}

export async function getAppTokenUser(db: D1Database, tokenHash: string): Promise<{ user: UserRow; tokenId: string; lastUsed: number } | null> {
  const r = await db
    .prepare("SELECT u.*, t.id AS token_id, t.last_used AS token_last_used FROM app_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?")
    .bind(tokenHash)
    .first<UserRow & { token_id: string; token_last_used: number }>();
  if (!r) return null;
  const { token_id, token_last_used, ...user } = r;
  return { user, tokenId: token_id, lastUsed: token_last_used };
}

/** Ghi lần dùng cuối của mã, và tính là tài khoản còn hoạt động (cron không xóa tài khoản chỉ dùng qua plugin). */
export async function touchAppToken(db: D1Database, tokenId: string, userId: string, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE app_tokens SET last_used = ? WHERE id = ?").bind(nowMs, tokenId),
    db.prepare("UPDATE users SET last_login = MAX(last_login, ?) WHERE id = ?").bind(nowMs, userId),
  ]);
}

export async function listAppTokens(db: D1Database, userId: string): Promise<AppTokenRow[]> {
  const r = await db.prepare("SELECT * FROM app_tokens WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<AppTokenRow>();
  return r.results;
}

/** Thêm mã nếu người đó chưa đủ `max` mã (kiểm và ghi trong một câu lệnh). */
export async function insertAppToken(db: D1Database, t: AppTokenRow, max: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO app_tokens (id, token_hash, user_id, name, created_at, last_used)
       SELECT ?1, ?2, ?3, ?4, ?5, 0 WHERE (SELECT COUNT(*) FROM app_tokens WHERE user_id = ?3) < ?6`,
    )
    .bind(t.id, t.token_hash, t.user_id, t.name, t.created_at, max)
    .run();
  return r.meta.changes > 0;
}

export async function deleteAppToken(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM app_tokens WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return r.meta.changes > 0;
}
