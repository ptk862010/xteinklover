import * as accounts from "./accounts";
import { unauthorized, userFromBasic, userFromSession } from "./auth";
import * as books from "./books";
import * as oauth from "./oauth";
import { ensureSchema } from "./db";
import { Env } from "./env";
import { error, sameOrigin } from "./http";

export type { Env } from "./env";

const BOOK_ID = "([a-z0-9]{9,24})";

/**
 * Trình duyệt mở thẳng /opds hoặc link sách mà chưa đăng nhập: trả trang giải thích thay vì hộp Basic auth
 * (người dùng dễ gõ mật khẩu tài khoản vào đó). Máy đọc sách không gửi Sec-Fetch-* nên vẫn nhận 401 Basic.
 */
function deviceOnlyPage(): Response {
  const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xteink Lover</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem">
<h1>Địa chỉ này dành cho máy đọc sách</h1>
<p>Điền địa chỉ <b>/opds</b> vào máy Xteink (Settings → System → OPDS Servers), với <b>tên đăng nhập</b> và <b>khóa OPDS</b>.
Đừng nhập mật khẩu tài khoản ở đây.</p><p><a href="/">← Về trang Xteink Lover</a></p></body></html>`;
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function isBrowserNavigation(req: Request): boolean {
  return req.headers.get("Sec-Fetch-Mode") === "navigate" || req.headers.get("Sec-Fetch-Dest") === "document";
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  const isApi = path.startsWith("/api/");
  const isDevice = path === "/opds" || path === "/opds/catalog" || path.startsWith("/books/");
  const isOauth = path === "/auth/google/callback";
  // Trang tĩnh (index.html, app.js, css) công khai; dữ liệu nằm sau API
  if (!isApi && !isDevice && !isOauth) {
    if (method === "GET" || method === "HEAD") return env.ASSETS.fetch(req);
    return error(405, "Không hỗ trợ");
  }

  if (path === "/api/config" && method === "GET") return oauth.config(env);

  await ensureSchema(env.DB);

  // ── Google chuyển về sau khi đăng nhập ──
  if (isOauth) return method === "GET" ? oauth.callback(req, env, url) : error(405, "Không hỗ trợ");

  // ── Máy đọc sách: Basic auth bằng khóa OPDS (trình duyệt đã đăng nhập cũng tải được sách) ──
  if (isDevice) {
    if (method !== "GET" && method !== "HEAD") return error(405, "Không hỗ trợ");
    const session = await userFromSession(env.DB, req, url);
    const user = session?.user ?? (await userFromBasic(env.DB, req.headers.get("Authorization")));
    if (!user) return isBrowserNavigation(req) ? deviceOnlyPage() : unauthorized();
    if (path === "/opds" || path === "/opds/catalog") return books.opdsFeed(env, url, user);
    const dl = path.match(new RegExp(`^/books/${BOOK_ID}\\.epub$`));
    if (dl) return books.download(env, user, dl[1]);
    return error(404, "Không có");
  }

  // ── API cho trang web: cookie phiên ──
  if (method !== "GET" && !sameOrigin(req, url)) return error(403, "Sai nguồn gửi");

  if (path === "/api/signup" && method === "POST") return accounts.signup(req, env, url);
  if (path === "/api/login" && method === "POST") return accounts.login(req, env, url, ctx);

  if (path === "/api/google/pending" && method === "GET") return oauth.pendingInfo(req, env, url);
  if (path === "/api/google/signup" && method === "POST") return oauth.signup(req, env, url);
  if (path === "/api/google/cancel" && method === "POST") return oauth.cancelPending(url);

  const auth = await userFromSession(env.DB, req, url);
  if (path === "/api/logout" && method === "POST") return accounts.logout(env, url, auth);
  if (path === "/api/google/start" && method === "POST") return oauth.start(req, env, url, auth);
  if (!auth) return error(401, "Cần đăng nhập");

  if (path === "/api/me" && method === "GET") return accounts.me(env, auth);
  if (path === "/api/password" && method === "POST") return accounts.changePassword(req, env, auth);
  if (path === "/api/opds-key" && method === "POST") return accounts.rotateOpdsKey(env, auth);
  if (path === "/api/google/unlink" && method === "POST") return oauth.unlink(env, auth);
  if (path === "/api/account" && method === "DELETE") return accounts.deleteAccount(req, env, url, auth, ctx);

  if (path === "/api/books") {
    if (method === "GET") return books.listBooks(env, auth.user);
    if (method === "POST") return books.upload(req, env, url, auth.user, ctx);
  }
  const one = path.match(new RegExp(`^/api/books/${BOOK_ID}$`));
  if (one && method === "DELETE") return books.remove(env, auth.user, one[1], ctx);

  return error(404, "Không có");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error("xteinklover error", req.method, new URL(req.url).pathname, e instanceof Error ? e.stack : e);
      // Hết quota free trong ngày (D1/KV) — báo rõ thay vì "lỗi máy chủ"
      if (/free tier|daily .*limit|limit exceeded|KV .*limit/i.test(String(e))) {
        return error(503, "Hệ thống đã dùng hết lượt miễn phí hôm nay, thử lại sau 7 giờ sáng");
      }
      return error(500, "Lỗi máy chủ, thử lại sau");
    }
  },

  /** Cron mỗi giờ (wrangler.toml [triggers]): dọn phiên hết hạn, bộ đếm cũ, tài khoản rỗng bỏ hoang, xóa file KV đang chờ. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env.DB);
        await accounts.cronHousekeeping(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
