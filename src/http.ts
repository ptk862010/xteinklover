/** Trợ giúp HTTP dùng chung: JSON, cookie phiên, chặn CSRF. */

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

export function error(status: number, message: string, headers: HeadersInit = {}): Response {
  return json({ error: message }, status, headers);
}

export const SESSION_DAYS = 30;

/** workers.dev và domain riêng đều HTTPS → dùng tiền tố __Host- (Secure, Path=/, không Domain). Local http thì bỏ. */
export function sessionCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-xl_session" : "xl_session";
}

export function sessionCookie(url: URL, token: string, maxAgeSec = SESSION_DAYS * 86400): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${sessionCookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function clearSessionCookie(url: URL): string {
  return sessionCookie(url, "", 0);
}

/** Cookie "thiết bị quen": trình duyệt đã đăng nhập đúng ít nhất một lần (không phải thông tin đăng nhập). */
export function deviceCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-xl_dev" : "xl_dev";
}

export function deviceCookie(url: URL, token: string): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${deviceCookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}${secure}`;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/**
 * Request đổi dữ liệu (POST/PUT/DELETE) từ trình duyệt phải cùng origin.
 * Trình duyệt luôn gửi Origin cho fetch POST/DELETE; thiếu Origin thì dựa vào Sec-Fetch-Site.
 * Máy đọc sách chỉ GET nên không bị ảnh hưởng.
 */
export function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("Origin");
  if (origin) return origin === url.origin;
  const site = req.headers.get("Sec-Fetch-Site");
  return site === "same-origin" || site === "none";
}

/** Đọc body JSON tối đa `maxBytes`, dừng đọc ngay khi vượt (kể cả khi không có Content-Length). */
export async function readJson(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > maxBytes || !req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Khóa IP cho bộ đếm chặn lạm dụng. IPv6: gom theo /64, vì một máy thường có cả dải /64
 * và đổi địa chỉ tùy ý. CF-Connecting-IP do Cloudflare đặt, client không giả được.
 */
export function clientIp(req: Request): string {
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  return ip.includes(":") ? ipv6Prefix64(ip) : ip;
}

export function ipv6Prefix64(ip: string): string {
  const addr = ip.split("%")[0].toLowerCase();
  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill("0"), ...t];
  return groups
    .slice(0, 4)
    .map((g) => (parseInt(g || "0", 16) || 0).toString(16))
    .join(":") + "::/64";
}
