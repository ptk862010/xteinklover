/**
 * Lấy trang web hộ trình duyệt (trình duyệt không tự tải được trang khác origin vì CORS).
 * Server chỉ chuyển nguyên byte về, không phân tích: cắt nội dung (Readability) và dựng EPUB chạy trên trình
 * duyệt, vì Workers free chỉ có 10 ms CPU. Chỉ cho người đã đăng nhập, có giới hạn lượt, chặn địa chỉ nội bộ.
 */
import * as db from "./db";
import { Env } from "./env";
import { error, readJson } from "./http";

const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;
const HOUR = 3600;
/** Lượt lấy trang / ảnh mỗi người mỗi giờ */
export const PAGES_PER_HOUR = 40;
export const IMAGES_PER_HOUR = 600;
const USER_AGENT = "Mozilla/5.0 (compatible; XteinkLover/1.0; +https://app.xteinklover.workers.dev)";

/**
 * Chỉ nhận http(s) tới tên miền công khai, cổng mặc định. Chặn IP viết thẳng, localhost, tên nội bộ,
 * và chính trang này (tránh vòng lặp). `allowLocal` chỉ dùng cho test tích hợp.
 * Chỉ kiểm theo chữ, không phân giải DNS: tên miền trỏ về IP nội bộ (vd x.nip.io) dựa vào việc Cloudflare
 * Workers không kết nối được tới dải IP riêng / loopback. Tự cài chạy chỗ khác thì phải chặn thêm ở tầng mạng.
 */
export function checkTarget(raw: unknown, selfHost: string, allowLocal = false): URL | string {
  if (typeof raw !== "string" || raw.length > 2048) return "Link không hợp lệ";
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "Link không hợp lệ";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Chỉ nhận link http(s)";
  if (u.username || u.password) return "Link không được chứa tên đăng nhập, mật khẩu";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (allowLocal && (host === "127.0.0.1" || host === "localhost")) return u;
  if (u.port && u.port !== "80" && u.port !== "443") return "Chỉ nhận cổng web thông thường";
  const isIp = /^\d+(\.\d+){3}$/.test(host) || host.startsWith("[") || /^\d+$/.test(host) || /^0x/i.test(host);
  if (isIp) return "Không nhận link tới địa chỉ IP, dùng tên miền";
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) return "Không nhận địa chỉ nội bộ";
  if (host === selfHost.toLowerCase()) return "Đây là link của chính Xteink Lover";
  return u;
}

/** Đọc tối đa `max` byte rồi dừng (không tin Content-Length). null = quá cỡ. */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const len = Number(res.headers.get("Content-Length") || 0);
  if (len > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Tự đi theo redirect, kiểm lại địa chỉ ở mỗi bước (redirect không được dẫn vào nội bộ). */
async function fetchChecked(start: URL, env: Env, selfHost: string, accept: string): Promise<{ res: Response; url: URL } | string> {
  let target = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(target.toString(), {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "vi,en;q=0.8" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return "Không mở được trang (hết giờ chờ hoặc trang không tồn tại)";
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) {
      await res.body?.cancel().catch(() => undefined);
      let loc: string;
      try {
        loc = new URL(res.headers.get("Location")!, target).toString();
      } catch {
        return "Trang chuyển hướng sang địa chỉ hỏng";
      }
      const next = checkTarget(loc, selfHost, env.FETCH_ALLOW_LOCAL === "1");
      if (typeof next === "string") return next;
      target = next;
      continue;
    }
    return { res, url: target };
  }
  return "Trang chuyển hướng quá nhiều lần";
}

async function rateLimit(env: Env, key: string, max: number): Promise<boolean> {
  return (await db.hitAttempt(env.DB, key, Math.floor(Date.now() / 1000), HOUR)) <= max;
}

/**
 * POST /api/fetch-page {url} → byte thô của trang HTML. Header X-Final-Url (sau redirect) và
 * X-Charset (theo Content-Type của trang, nếu có) để trình duyệt tự giải mã.
 */
export async function fetchPage(req: Request, env: Env, url: URL, user: db.UserRow): Promise<Response> {
  const body = await readJson(req);
  const target = checkTarget(body?.url, url.hostname, env.FETCH_ALLOW_LOCAL === "1");
  if (typeof target === "string") return error(400, target);
  if (!(await rateLimit(env, `clip:user:${user.id}`, PAGES_PER_HOUR))) return error(429, `Tối đa ${PAGES_PER_HOUR} link mỗi giờ, thử lại sau`);

  const got = await fetchChecked(target, env, url.hostname, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5");
  if (typeof got === "string") return error(422, got);
  const { res, url: finalUrl } = got;
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return error(422, "Trang cần đăng nhập hoặc chặn truy cập tự động. Mở bài trên trình duyệt, copy nội dung rồi dán vào tab “Dán văn bản”");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return error(422, `Trang trả về lỗi ${res.status}`);
  }
  const type = (res.headers.get("Content-Type") || "").toLowerCase();
  if (!/html|xml/.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    return error(422, "Link này không phải trang web (có thể là file). Tải file về rồi thả vào ô gửi file");
  }
  const bytes = await readCapped(res, PAGE_MAX_BYTES);
  if (!bytes) return error(413, "Trang quá lớn");
  const charset = type.match(/charset=["']?([\w-]+)/)?.[1] ?? "";
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Final-Url": finalUrl.toString(),
      "X-Charset": charset,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** GET /api/fetch-image?url= → ảnh trong bài (trình duyệt thu nhỏ rồi nhúng vào EPUB). Không nhận SVG. */
export async function fetchImage(env: Env, url: URL, user: db.UserRow): Promise<Response> {
  const target = checkTarget(url.searchParams.get("url"), url.hostname, env.FETCH_ALLOW_LOCAL === "1");
  if (typeof target === "string") return error(400, target);
  if (!(await rateLimit(env, `clipimg:user:${user.id}`, IMAGES_PER_HOUR))) return error(429, "Tải ảnh quá nhiều, thử lại sau");
  const got = await fetchChecked(target, env, url.hostname, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8");
  if (typeof got === "string") return error(422, got);
  const { res } = got;
  const type = (res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!res.ok || !type.startsWith("image/") || type.includes("svg")) {
    await res.body?.cancel().catch(() => undefined);
    return error(422, "Không phải ảnh");
  }
  const bytes = await readCapped(res, IMAGE_MAX_BYTES);
  if (!bytes) return error(413, "Ảnh quá lớn");
  return new Response(bytes, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
