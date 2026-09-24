import { SessionAuth, opdsKeyHash, sessionHash } from "./auth";
import { CLIENT_KDF, PasswordHash, SERVER_ITERATIONS, hashProof, newReadableKey, newToken, sha256Hex, timingSafeEqualStr, verifyProof } from "./crypto";
import * as db from "./db";
import { Env, limits } from "./env";
import { SESSION_DAYS, clearSessionCookie, clientIp, deviceCookie, deviceCookieName, error, json, readCookie, readJson, sessionCookie } from "./http";
import { isProof, normalizeUsername, usernameError } from "./validate";

const WINDOW = 15 * 60; // giây
/** Sai liên tiếp từ MỘT nơi (tên + IP) — chặn dò mật khẩu mà người ngoài không khóa được chủ tài khoản. */
const LOGIN_MAX_PER_PAIR = 10;
/**
 * Tổng mọi nơi cho một tên — chặn dò phân tán. Trình duyệt "quen" (đã từng đăng nhập đúng tên này) không bị
 * tính và không bị chặn bởi trần này, nên người ngoài dò từ nhiều IP không khóa được chủ tài khoản.
 */
const LOGIN_MAX_PER_USER = 30;
const LOGIN_MAX_PER_IP = 30;
/** Nhập lại mật khẩu (đổi mật khẩu, xóa tài khoản) sai tối đa bao nhiêu lần trong MỘT phiên. */
const RECHECK_MAX = 5;
const SIGNUP_WINDOW = 60 * 60;
const SIGNUP_MAX_PER_IP = 5;
const DAY = 86400;

/** Hash giả để đăng nhập tên không tồn tại vẫn tốn cùng thời gian như tên có thật. */
const DUMMY = { hash: "0".repeat(64), salt: "00".repeat(16), iterations: SERVER_ITERATIONS };

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function storedHash(u: db.UserRow) {
  return { hash: u.pass_hash, salt: u.pass_salt, iterations: u.pass_iter };
}

export function hasPassword(u: db.UserRow): boolean {
  return u.pass_iter > 0;
}

function publicUser(u: db.UserRow) {
  return { username: u.username, created: u.created_at, hasPassword: hasPassword(u) };
}

/** Tài khoản chỉ có Google: thao tác nhạy cảm (xóa tài khoản) cần vừa đăng nhập lại bằng Google trong ngần này. */
export const FRESH_LOGIN_MS = 10 * 60 * 1000;

const tooMany = () => error(429, "Sai quá nhiều lần, đợi 15 phút rồi thử lại");

/** Dọn dẹp chạy nền sau khi đăng nhập: phiên hết hạn, file KV chờ xóa. */
export async function housekeeping(env: Env): Promise<void> {
  await Promise.allSettled([db.purgeSessions(env.DB, Date.now()), db.drainBlobDeletes(env.DB, env.BOOKS)]);
}

/** Việc theo lịch (index.ts scheduled): như trên + bộ đếm cũ, tài khoản rỗng bỏ hoang. */
export async function cronHousekeeping(env: Env): Promise<void> {
  const now = Date.now();
  await Promise.allSettled([db.cronCleanup(env.DB, now), db.purgeSessions(env.DB, now), db.drainBlobDeletes(env.DB, env.BOOKS, 40)]);
}

const deviceHash = (token: string) => sha256Hex("device:" + token);

/** Đăng ký mở khi có mã mời, hoặc chủ trang bật OPEN_SIGNUP="1" (bản hosted). */
export function signupOpen(env: Env): boolean {
  return !!env.SIGNUP_CODE?.trim() || env.OPEN_SIGNUP === "1";
}

/**
 * Chặn lạm dụng chung cho mọi kiểu đăng ký (mật khẩu, Google): lượt theo IP, mã mời, trần mỗi ngày.
 * Qua được thì trả về hàm trả lại lượt ngày (gọi khi tạo tài khoản thất bại).
 */
export async function admitSignup(req: Request, env: Env, code: unknown): Promise<{ error: Response } | { giveBack: () => Promise<void> }> {
  if (!signupOpen(env)) return { error: error(403, "Trang này chưa mở đăng ký (chủ trang cần đặt SIGNUP_CODE)") };
  // Lượt theo IP (giữ cả khi thất bại: chặn dò mã mời và dò tên)
  const now = nowSec();
  const ipKey = `signup:ip:${clientIp(req)}`;
  const slow = () => ({ error: error(429, "Đăng ký quá nhiều lần, thử lại sau một giờ") });
  if ((await db.peekAttempt(env.DB, ipKey, now, SIGNUP_WINDOW)) >= SIGNUP_MAX_PER_IP) return slow();
  if ((await db.hitAttempt(env.DB, ipKey, now, SIGNUP_WINDOW)) > SIGNUP_MAX_PER_IP) return slow();

  if (env.SIGNUP_CODE?.trim()) {
    const c = typeof code === "string" ? code.trim() : "";
    if (!timingSafeEqualStr(c, env.SIGNUP_CODE.trim())) return { error: error(403, "Mã mời không đúng") };
  }

  // Trần đăng ký mới mỗi ngày của cả hệ thống — chỉ tính lượt tạo được tài khoản
  const lim = limits(env);
  const dayKey = `signup:all:${utcDay()}`;
  if (lim.maxSignupsPerDay > 0 && (await db.hitAttempt(env.DB, dayKey, now, DAY)) > lim.maxSignupsPerDay) {
    await db.unhitAttempt(env.DB, dayKey);
    return { error: error(429, "Hôm nay đã đủ lượt đăng ký mới, mai quay lại nhé") };
  }
  return { giveBack: () => (lim.maxSignupsPerDay > 0 ? db.unhitAttempt(env.DB, dayKey) : Promise.resolve()) };
}

export interface NewAccount {
  username: string;
  /** null = tài khoản chỉ đăng nhập bằng Google */
  password: PasswordHash | null;
  identity?: { provider: string; subject: string };
  /** Chỗ giữ tên (oauth_pending) được xóa cùng lúc khi tạo xong */
  pendingHash?: string;
}

/**
 * Tạo user + phiên + thiết bị quen (+ liên kết Google) trong một transaction, kiểm MAX_USERS trong cùng câu lệnh
 * để đăng ký song song không vượt trần. Trả 201 kèm khóa OPDS (chỉ hiện một lần) và cookie.
 */
export async function createAccount(env: Env, url: URL, acc: NewAccount, giveBack: () => Promise<void>, extraCookies: string[] = []): Promise<Response> {
  const lim = limits(env);
  const opdsKey = newReadableKey();
  const nowMs = Date.now();
  const user: db.UserRow = {
    id: crypto.randomUUID(),
    username: acc.username,
    pass_hash: acc.password?.hash ?? "",
    pass_salt: acc.password?.salt ?? "",
    pass_iter: acc.password?.iterations ?? 0,
    client_kdf: acc.password ? CLIENT_KDF : "none",
    opds_key_hash: await opdsKeyHash(opdsKey),
    created_at: new Date(nowMs).toISOString(),
    last_login: nowMs,
  };
  const token = newToken();
  const device = newToken();
  const ifUser = "WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)";
  const stmts = [
    env.DB.prepare(
      `INSERT INTO users (id, username, pass_hash, pass_salt, pass_iter, client_kdf, opds_key_hash, created_at, last_login)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10
       WHERE ?9 = 0 OR (SELECT COUNT(*) FROM users) < ?9`,
    ).bind(user.id, user.username, user.pass_hash, user.pass_salt, user.pass_iter, user.client_kdf, user.opds_key_hash, user.created_at, lim.maxUsers, user.last_login),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) SELECT ?1, ?2, ?3 ${ifUser}`).bind(
      await sessionHash(token),
      user.id,
      nowMs + SESSION_DAYS * 86400_000,
    ),
    env.DB.prepare(`INSERT INTO devices (token_hash, user_id, created_at) SELECT ?1, ?2, ?3 ${ifUser}`).bind(await deviceHash(device), user.id, nowMs),
  ];
  if (acc.identity) {
    stmts.push(
      env.DB.prepare(`INSERT INTO identities (provider, subject, user_id, created_at) SELECT ?1, ?3, ?2, ?4 ${ifUser}`).bind(
        acc.identity.provider,
        user.id,
        acc.identity.subject,
        nowMs,
      ),
    );
  }
  if (acc.pendingHash) {
    stmts.push(env.DB.prepare(`DELETE FROM oauth_pending WHERE token_hash = ?1 AND EXISTS (SELECT 1 FROM users WHERE id = ?2)`).bind(acc.pendingHash, user.id));
  }
  let inserted: boolean;
  try {
    const [ins] = await env.DB.batch(stmts);
    inserted = ins.meta.changes > 0;
  } catch (e) {
    await giveBack();
    const msg = String(e);
    if (msg.includes("UNIQUE") && msg.includes("identities")) return error(409, "Google này đã có tài khoản rồi, bấm Đăng nhập bằng Google");
    if (msg.includes("UNIQUE")) return error(409, "Tên đăng nhập đã có người dùng");
    throw e;
  }
  if (!inserted) {
    await giveBack();
    return error(403, "Đã đủ số tài khoản, hiện không nhận đăng ký mới");
  }
  // Khóa OPDS chỉ hiện một lần ở đây; quên thì tạo khóa mới
  const res = json({ user: publicUser(user), opdsKey }, 201);
  res.headers.append("Set-Cookie", sessionCookie(url, token));
  res.headers.append("Set-Cookie", deviceCookie(url, device));
  for (const c of extraCookies) res.headers.append("Set-Cookie", c);
  return res;
}

export async function signup(req: Request, env: Env, url: URL): Promise<Response> {
  if (!signupOpen(env)) return error(403, "Trang này chưa mở đăng ký (chủ trang cần đặt SIGNUP_CODE)");
  // Kiểm định dạng trước (không tốn D1) — gõ sai tên không bị tính lượt
  const body = await readJson(req);
  if (!body) return error(400, "Dữ liệu không hợp lệ");
  const username = normalizeUsername(body.username);
  const uErr = usernameError(username);
  if (uErr) return error(400, uErr);
  if (!isProof(body.proof)) return error(400, "Mật khẩu không hợp lệ, tải lại trang rồi thử lại");
  const admit = await admitSignup(req, env, body.code);
  if ("error" in admit) return admit.error;
  return createAccount(env, url, { username, password: await hashProof(body.proof) }, admit.giveBack);
}

/**
 * Mở phiên cho người vừa xác thực xong (mật khẩu hoặc Google): cookie phiên, và cookie thiết bị quen nếu
 * trình duyệt này chưa quen với tài khoản đó.
 */
export async function startSession(req: Request, env: Env, url: URL, user: db.UserRow, res: Response): Promise<void> {
  const token = newToken();
  const nowMs = Date.now();
  await db.createSession(env.DB, await sessionHash(token), user.id, nowMs + SESSION_DAYS * 86400_000, nowMs);
  res.headers.append("Set-Cookie", sessionCookie(url, token));
  if (!(await isKnownDeviceFor(req, env, url, user.id))) {
    const device = newToken();
    await db.addDevice(env.DB, await deviceHash(device), user.id, nowMs);
    res.headers.append("Set-Cookie", deviceCookie(url, device));
  }
}

async function isKnownDeviceFor(req: Request, env: Env, url: URL, userId: string): Promise<boolean> {
  const devToken = readCookie(req, deviceCookieName(url));
  return !!devToken && /^[0-9a-f]{64}$/.test(devToken) && (await db.isKnownDevice(env.DB, await deviceHash(devToken), userId));
}

export async function login(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(req);
  if (!body) return error(400, "Dữ liệu không hợp lệ");
  const username = normalizeUsername(body.username);
  if (!username || username.length > 32 || !isProof(body.proof)) return error(401, "Sai tên đăng nhập hoặc mật khẩu");

  const now = nowSec();
  const ip = clientIp(req);
  const pairKey: [string, number] = [`login:pair:${username}|${ip}`, WINDOW];
  const ipKey: [string, number] = [`login:ip:${ip}`, WINDOW];
  const userKey: [string, number] = [`login:user:${username}`, WINDOW];

  const user = await db.getUserByName(env.DB, username);
  const knownDevice = !!user && (await isKnownDeviceFor(req, env, url, user.id));

  // Chặn nhanh (chỉ đọc) nếu đã bị khóa, rồi giữ lượt nguyên tử TRƯỚC khi kiểm mật khẩu,
  // để nhiều request song song không lách được giới hạn.
  const [pairSeen, ipSeen, userSeen] = await db.peekAttempts(env.DB, [pairKey, ipKey, userKey], now);
  if (pairSeen >= LOGIN_MAX_PER_PAIR || ipSeen >= LOGIN_MAX_PER_IP || (!knownDevice && userSeen >= LOGIN_MAX_PER_USER)) return tooMany();
  // Bộ đếm theo nơi gửi trước; bị chặn ở đây thì không đụng bộ đếm chung của tên (chủ tài khoản không bị khóa lây)
  const [pairN, ipN] = await db.hitAttempts(env.DB, [pairKey, ipKey], now);
  if (pairN > LOGIN_MAX_PER_PAIR || ipN > LOGIN_MAX_PER_IP) return tooMany();
  if (!knownDevice && (await db.hitAttempt(env.DB, userKey[0], now, WINDOW)) > LOGIN_MAX_PER_USER) return tooMany();

  // Tài khoản chỉ có Google (không mật khẩu): vẫn băm với hash giả cho đều thời gian, rồi từ chối
  const withPassword = user && hasPassword(user) ? user : null;
  const ok = (await verifyProof(body.proof, withPassword ? storedHash(withPassword) : DUMMY)) && !!withPassword;
  if (!ok || !user) return error(401, "Sai tên đăng nhập hoặc mật khẩu");

  // Đăng nhập đúng: xóa bộ đếm sai của nơi này, trả lại lượt đã giữ ở bộ đếm chung
  const giveBack = [ipKey[0], ...(knownDevice ? [] : [userKey[0]])];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(pairKey[0]),
    ...giveBack.map((k) => env.DB.prepare("UPDATE attempts SET count = MAX(count - 1, 0) WHERE key = ?").bind(k)),
  ]);
  const res = json({ user: publicUser(user) }, 200);
  await startSession(req, env, url, user, res);
  ctx.waitUntil(housekeeping(env));
  return res;
}

export async function logout(env: Env, url: URL, auth: SessionAuth | null): Promise<Response> {
  if (auth) await db.deleteSession(env.DB, auth.tokenHash);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(url) });
}

export async function me(env: Env, user: db.UserRow): Promise<Response> {
  const lim = limits(env);
  const [usage, today, google] = await Promise.all([
    db.userUsage(env.DB, user.id),
    db.peekAttempt(env.DB, uploadKeyUser(user.id), nowSec(), DAY),
    db.hasIdentity(env.DB, user.id, "google"),
  ]);
  return json({
    user: { ...publicUser(user), google },
    usage: { books: usage.books, bytes: usage.bytes, uploadsToday: today },
    limits: {
      maxUploadBytes: lim.maxUploadBytes,
      maxBooks: lim.maxBooksPerUser,
      maxStorageBytes: lim.maxStoragePerUser,
      maxUploadsPerDay: lim.maxUploadsPerDay,
    },
  });
}

/**
 * Nhập lại mật khẩu cho thao tác nhạy cảm. Đếm số lần sai trên CHÍNH phiên đang dùng (cột sessions.recheck_fails):
 * phiên bị trộm chỉ đoán được RECHECK_MAX lần rồi bị hủy, còn các phiên khác của chủ tài khoản không bị ảnh hưởng.
 * Giữ lượt trước khi kiểm để gửi song song không lách được.
 */
export async function recheckPassword(env: Env, auth: SessionAuth, proof: unknown): Promise<Response | null> {
  if (!hasPassword(auth.user)) return error(400, "Tài khoản này đăng nhập bằng Google, chưa có mật khẩu");
  if (!isProof(proof)) return error(400, "Dữ liệu không hợp lệ");
  const locked = async () => {
    await db.deleteSession(env.DB, auth.tokenHash);
    return error(429, "Sai mật khẩu quá nhiều lần. Phiên này đã bị đăng xuất, hãy đăng nhập lại");
  };
  if ((await db.sessionRecheckFails(env.DB, auth.tokenHash)) >= RECHECK_MAX) return locked();
  if ((await db.sessionRecheckFail(env.DB, auth.tokenHash)) > RECHECK_MAX) return locked();
  if (!(await verifyProof(proof, storedHash(auth.user)))) return error(403, "Mật khẩu không đúng");
  await env.DB.prepare("UPDATE sessions SET recheck_fails = MAX(recheck_fails - 1, 0) WHERE token_hash = ?").bind(auth.tokenHash).run();
  return null;
}

export async function changePassword(req: Request, env: Env, auth: SessionAuth): Promise<Response> {
  const body = await readJson(req);
  if (!body || !isProof(body.next)) return error(400, "Dữ liệu không hợp lệ");
  const bad = await recheckPassword(env, auth, body.current);
  if (bad) return bad;
  // Đổi mật khẩu + đăng xuất mọi nơi khác trong một transaction
  await db.changePasswordAndRevoke(env.DB, auth.user.id, await hashProof(body.next), auth.tokenHash);
  return json({ ok: true });
}

/**
 * Tạo khóa OPDS mới; khóa cũ trên máy hết hiệu lực ngay. Gọi được từ web (phiên) và từ mã ứng dụng
 * (plugin Obsidian tự ghi khóa mới vào máy đọc qua WiFi).
 */
export async function rotateOpdsKey(env: Env, user: db.UserRow): Promise<Response> {
  const opdsKey = newReadableKey();
  await db.updateOpdsKey(env.DB, user.id, await opdsKeyHash(opdsKey));
  return json({ opdsKey, username: user.username });
}

export async function deleteAccount(req: Request, env: Env, url: URL, auth: SessionAuth, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(req);
  if (hasPassword(auth.user)) {
    const bad = await recheckPassword(env, auth, body?.proof);
    if (bad) return bad;
  } else {
    // Chỉ có Google: gõ đúng tên đăng nhập, và phiên phải vừa đăng nhập lại bằng Google (phiên cũ bị trộm không xóa được)
    if (normalizeUsername(body?.confirm) !== auth.user.username) return error(400, "Gõ đúng tên đăng nhập để xác nhận");
    if (Date.now() - auth.createdAt > FRESH_LOGIN_MS) return json({ error: "Đăng nhập lại bằng Google để xác nhận xóa", reauth: true }, 403);
  }
  // Dòng sách, phiên, user xóa trong một transaction; file KV vào hàng chờ, xóa nền (KV free: 1.000 xóa/ngày)
  await db.deleteUserCascade(env.DB, auth.user.id, Date.now());
  ctx.waitUntil(db.drainBlobDeletes(env.DB, env.BOOKS).then(() => undefined, () => undefined));
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(url) });
}

// ── đếm lượt theo ngày UTC (quota free reset 00:00 UTC = 7:00 sáng VN) ──

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function uploadKeyUser(userId: string, now = new Date()): string {
  return `upload:user:${userId}:${utcDay(now)}`;
}

export function uploadKeyAll(now = new Date()): string {
  return `upload:all:${utcDay(now)}`;
}
