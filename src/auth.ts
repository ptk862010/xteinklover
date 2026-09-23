import { sha256Hex, timingSafeEqualStr } from "./crypto";
import { UserRow, getSessionUser, getUserByName } from "./db";
import { SESSION_DAYS, readCookie, sessionCookieName } from "./http";
import { normalizeUsername } from "./validate";

/** HTTP Basic auth — CrossPoint chỉ hỗ trợ Basic (không Digest). */
export function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !/^Basic\s+/i.test(header)) return null;
  try {
    const bin = atob(header.replace(/^Basic\s+/i, "").trim());
    const decoded = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

export function unauthorized(realm = "Xteink Lover"): Response {
  return new Response("Cần đăng nhập", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`, "Cache-Control": "no-store" },
  });
}

/** Khóa OPDS gõ trên máy: bỏ gạch, khoảng trắng, không phân biệt hoa thường. */
export function normalizeOpdsKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function opdsKeyHash(key: string): Promise<string> {
  return sha256Hex("opds:" + normalizeOpdsKey(key));
}

/** Máy đọc sách: Basic auth = tên đăng nhập + khóa OPDS. Chỉ SHA-256, không PBKDF2 → rẻ CPU. */
export async function userFromBasic(db: D1Database, header: string | null): Promise<UserRow | null> {
  const c = parseBasicAuth(header);
  if (!c || !c.pass || c.pass.length > 200) return null;
  const username = normalizeUsername(c.user);
  if (!username || username.length > 32) return null;
  const user = await getUserByName(db, username);
  const got = await opdsKeyHash(c.pass);
  // So sánh cả khi không có user để thời gian phản hồi không lộ tên nào tồn tại
  const ok = timingSafeEqualStr(got, user?.opds_key_hash ?? "0".repeat(64));
  return ok && user ? user : null;
}

export async function sessionHash(token: string): Promise<string> {
  return sha256Hex("session:" + token);
}

export interface SessionAuth {
  user: UserRow;
  tokenHash: string;
  /** Lúc phiên được tạo (ms) — dùng cho thao tác cần đăng nhập mới đây (tài khoản chỉ có Google) */
  createdAt: number;
}

/** Trình duyệt: cookie phiên. */
export async function userFromSession(db: D1Database, req: Request, url: URL, now = Date.now()): Promise<SessionAuth | null> {
  const token = readCookie(req, sessionCookieName(url));
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sessionHash(token);
  const s = await getSessionUser(db, tokenHash, now);
  return s ? { user: s.user, tokenHash, createdAt: s.expiresAt - SESSION_DAYS * 86400_000 } : null;
}
