/**
 * Mã cho ứng dụng (plugin Obsidian, script…): gửi `Authorization: Bearer xlapp_…`.
 * Chỉ làm được việc với kệ sách (xem, gửi, xóa sách), xem tài khoản và tạo khóa OPDS mới (để plugin ghi vào máy
 * đọc) — không đổi mật khẩu, không tạo mã mới, không xóa tài khoản. Mã là 256 bit ngẫu nhiên nên chỉ cần SHA-256; hiện một lần lúc tạo, thu hồi riêng từng mã.
 * Trình duyệt không tự gửi header Authorization, và trang khác không gọi được vì không bật CORS → không có CSRF.
 */
import { FRESH_LOGIN_MS, hasPassword, recheckPassword } from "./accounts";
import { SessionAuth } from "./auth";
import { newToken, sha256Hex, toHex, randomBytes } from "./crypto";
import * as db from "./db";
import { Env } from "./env";
import { error, json, readJson } from "./http";
import { cleanText } from "./validate";

export const TOKEN_PREFIX = "xlapp_";
const TOKEN_RE = /^xlapp_[0-9a-f]{64}$/;
export const MAX_TOKENS_PER_USER = 5;
/** Ghi "lần dùng cuối" tối đa mỗi giờ một lần (đỡ tốn lượt ghi D1). */
const TOUCH_EVERY_MS = 3600_000;

export const tokenHash = (token: string) => sha256Hex("app:" + token);

/** Lấy mã từ header. undefined = không có Bearer; null = có nhưng sai dạng. */
export function bearerToken(header: string | null): string | null | undefined {
  if (!header || !/^Bearer\s/i.test(header)) return undefined;
  const t = header.replace(/^Bearer\s+/i, "").trim();
  return TOKEN_RE.test(t) ? t : null;
}

export async function userFromBearer(env: Env, token: string, ctx: ExecutionContext): Promise<db.UserRow | null> {
  const found = await db.getAppTokenUser(env.DB, await tokenHash(token));
  if (!found) return null;
  if (Date.now() - found.lastUsed > TOUCH_EVERY_MS) ctx.waitUntil(db.touchAppToken(env.DB, found.tokenId, found.user.id, Date.now()).catch(() => undefined));
  return found.user;
}

export async function list(env: Env, auth: SessionAuth): Promise<Response> {
  const rows = await db.listAppTokens(env.DB, auth.user.id);
  return json(rows.map((r) => ({ id: r.id, name: r.name, created: r.created_at, lastUsed: r.last_used || null })));
}

/**
 * Tạo mã = thêm một cách vào tài khoản lâu dài, nên phải xác nhận như khi liên kết Google:
 * nhập lại mật khẩu, hoặc (tài khoản chỉ có Google) vừa đăng nhập lại trong 10 phút.
 */
export async function create(req: Request, env: Env, auth: SessionAuth): Promise<Response> {
  const body = await readJson(req);
  if (hasPassword(auth.user)) {
    const bad = await recheckPassword(env, auth, body?.proof);
    if (bad) return bad;
  } else if (Date.now() - auth.createdAt > FRESH_LOGIN_MS) {
    return json({ error: "Đăng nhập lại bằng Google để tạo mã", reauth: true }, 403);
  }
  const name = cleanText(body?.name, "Ứng dụng", 40);
  const token = TOKEN_PREFIX + newToken();
  const row: db.AppTokenRow = { id: toHex(randomBytes(8)), token_hash: await tokenHash(token), user_id: auth.user.id, name, created_at: Date.now(), last_used: 0 };
  if (!(await db.insertAppToken(env.DB, row, MAX_TOKENS_PER_USER))) {
    return error(409, `Tối đa ${MAX_TOKENS_PER_USER} mã, thu hồi bớt mã cũ trước`);
  }
  // Mã chỉ hiện một lần ở đây
  return json({ id: row.id, name, token }, 201);
}

export async function revoke(env: Env, auth: SessionAuth, id: string): Promise<Response> {
  return (await db.deleteAppToken(env.DB, auth.user.id, id)) ? json({ ok: true }) : error(404, "Không có mã này");
}
