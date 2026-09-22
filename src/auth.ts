/** HTTP Basic auth — CrossPoint chỉ hỗ trợ Basic (không Digest). */
export function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !/^Basic\s+/i.test(header)) return null;
  try {
    const decoded = atob(header.replace(/^Basic\s+/i, "").trim());
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

/** So sánh không lộ độ dài qua thời gian (đủ dùng cho catalog cá nhân). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function isAuthorized(header: string | null, user: string, pass: string): boolean {
  const c = parseBasicAuth(header);
  return !!c && safeEqual(c.user, user) && safeEqual(c.pass, pass);
}

export function unauthorized(realm = "Xteink Lover"): Response {
  return new Response("Cần đăng nhập", { status: 401, headers: { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"` } });
}
