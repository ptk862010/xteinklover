import { uploadKeyAll, uploadKeyUser } from "./accounts";
import * as db from "./db";
import { Env, limits } from "./env";
import { error, json } from "./http";
import { OPDS_CONTENT_TYPE, acquisitionFeed, newBookId } from "./opds";
import { cleanText } from "./validate";

/** CrossPoint 1.6.0 chỉ giữ 62 mục mỗi trang feed (OpdsParser MAX_ENTRIES) → chia trang dưới mức đó. */
export const OPDS_PAGE_SIZE = 50;
const MAX_PAGE = 20;
const DAY = 86400;
const NOT_EPUB = "Chỉ nhận EPUB (trang web tự chuyển file khác sang EPUB trước khi gửi)";

/** Máy đọc sách: feed OPDS riêng của từng người, có phân trang rel=next/previous. */
export async function opdsFeed(env: Env, url: URL, user: db.UserRow): Promise<Response> {
  const page = Math.min(Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1), MAX_PAGE);
  const rows = await db.listBooks(env.DB, user.id, OPDS_PAGE_SIZE + 1, (page - 1) * OPDS_PAGE_SIZE);
  const books = rows.slice(0, OPDS_PAGE_SIZE).map(db.toMeta);
  const base = url.origin;
  const pageUrl = (p: number) => (p <= 1 ? `${base}/opds` : `${base}/opds?page=${p}`);
  const title = `${env.CATALOG_TITLE || "Xteink Lover"} — ${user.username}${page > 1 ? ` (trang ${page})` : ""}`;
  const xml = acquisitionFeed({
    base,
    title,
    books,
    updated: books[0]?.added ?? user.created_at,
    self: pageUrl(page),
    next: rows.length > OPDS_PAGE_SIZE && page < MAX_PAGE ? pageUrl(page + 1) : undefined,
    prev: page > 1 ? pageUrl(page - 1) : undefined,
  });
  return new Response(xml, { headers: { "Content-Type": OPDS_CONTENT_TYPE, "Cache-Control": "private, no-store" } });
}

export async function listBooks(env: Env, user: db.UserRow): Promise<Response> {
  return json((await db.listBooks(env.DB, user.id)).map(db.toMeta));
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Gửi sách: body là file EPUB thô (Content-Type application/epub+zip), tiêu đề và tác giả ở query.
 * Bắt buộc Content-Length để chặn file quá cỡ trước khi đọc.
 * Thứ tự: xem quota (chỉ đọc) → đọc và kiểm file → giữ lượt (nguyên tử) → thêm dòng D1 nếu kệ và kho chung
 * còn chỗ (một câu lệnh) → ghi KV. Bước nào hỏng thì trả lại lượt (chạy nền để client ngắt kết nối cũng không mất).
 */
export async function upload(req: Request, env: Env, url: URL, user: db.UserRow, ctx: ExecutionContext): Promise<Response> {
  const lim = limits(env);
  const lenHeader = req.headers.get("Content-Length");
  const len = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : NaN;
  if (!Number.isFinite(len)) return error(411, "Thiếu Content-Length");
  if (len > lim.maxUploadBytes) return error(413, `File quá ${mb(lim.maxUploadBytes)}`);
  if (len < 22) return error(415, NOT_EPUB);

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const counters: [string, number][] = [
    [uploadKeyUser(user.id, now), DAY],
    [uploadKeyAll(now), DAY],
  ];
  const overUser = () => error(429, `Hôm nay đã gửi ${lim.maxUploadsPerDay} cuốn, mai gửi tiếp nhé`);
  const overAll = () => error(503, "Hệ thống đã hết lượt gửi hôm nay (gói miễn phí), thử lại sau 7 giờ sáng");
  // 1. Xem trước (không ghi gì) để khỏi đọc file khi đã hết lượt
  const [seenUser, seenAll] = await db.peekAttempts(env.DB, counters, nowSec);
  if (seenUser >= lim.maxUploadsPerDay) return overUser();
  if (seenAll >= lim.maxUploadsPerDayTotal) return overAll();

  // 2. Đọc và kiểm file trước khi giữ lượt: file rác không tốn lượt ghi D1 nào
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return error(400, "Tải lên bị ngắt, thử lại");
  }
  if (bytes.length > lim.maxUploadBytes) return error(413, `File quá ${mb(lim.maxUploadBytes)}`);
  const isZip = bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) return error(415, NOT_EPUB);

  // 3. Giữ lượt nguyên tử (chặn gửi song song vượt trần)
  const [perUser, perAll] = await db.hitAttempts(env.DB, counters, nowSec);
  const giveBack = () => {
    ctx.waitUntil(Promise.allSettled(counters.map(([k]) => db.unhitAttempt(env.DB, k))).then(() => undefined));
  };
  if (perUser > lim.maxUploadsPerDay || perAll > lim.maxUploadsPerDayTotal) {
    giveBack();
    return perUser > lim.maxUploadsPerDay ? overUser() : overAll();
  }

  // 4. Thêm dòng sách nếu kệ và kho chung còn chỗ (trigger tự cộng dung lượng chung)
  const id = newBookId();
  const row: db.BookRow = {
    id,
    user_id: user.id,
    title: cleanText(url.searchParams.get("title"), "Không tên"),
    author: cleanText(url.searchParams.get("author"), ""),
    size: bytes.length,
    added: now.toISOString(),
    blob_key: `b:${id}`,
  };
  const inserted = await db.insertBookWithinQuota(env.DB, row, lim.maxBooksPerUser, lim.maxStoragePerUser, lim.maxStorageTotal);
  if (inserted !== "ok") {
    giveBack();
    return inserted === "store_full"
      ? error(507, "Kho chung đã đầy, chưa nhận thêm sách được. Xin lỗi, thử lại sau nhé")
      : error(403, `Kệ đã đủ ${lim.maxBooksPerUser} cuốn hoặc ${mb(lim.maxStoragePerUser)}, xóa bớt rồi gửi tiếp`);
  }

  // 5. Ghi file. Đăng ký với waitUntil để client ngắt kết nối giữa chừng thì phần ghi / hoàn tác vẫn chạy xong.
  const store = (async () => {
    try {
      await env.BOOKS.put(row.blob_key, bytes);
    } catch (e) {
      // Có thể file đã ghi một phần: gỡ dòng + đưa file vào hàng chờ xóa (trigger trả lại dung lượng khi xóa xong)
      const k = await db.takeBook(env.DB, user.id, id, Date.now()).catch(() => null);
      if (k) await db.finishBlobDelete(env.DB, env.BOOKS, k).catch(() => undefined);
      await Promise.allSettled(counters.map(([c]) => db.unhitAttempt(env.DB, c)));
      throw e;
    }
    // Sách bị xóa (hoặc tài khoản bị xóa) trong lúc đang ghi → file thành mồ côi, cho vào hàng chờ xóa
    await db.queueIfOrphan(env.DB, row, Date.now()).catch(() => undefined);
  })();
  ctx.waitUntil(store.catch(() => undefined));
  await store;
  return json({ ok: true, book: db.toMeta(row) }, 201);
}

/** Cắt theo ký tự (code point), không cắt đôi emoji. */
function cutChars(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/** Tên file an toàn cho header; giữ tiếng Việt qua filename*. */
export function contentDisposition(title: string, id: string): string {
  const ascii = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
  const safe = ascii.replace(/[^A-Za-z0-9 ._-]+/g, "_").trim().slice(0, 80) || id;
  const utf8 = encodeURIComponent(cutChars(title, 120)).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${safe}.epub"; filename*=UTF-8''${utf8}.epub`;
}

export async function download(env: Env, user: db.UserRow, id: string): Promise<Response> {
  const row = await db.getBook(env.DB, user.id, id);
  if (!row) return new Response("Không có sách này", { status: 404 });
  const value = await env.BOOKS.get(row.blob_key, "stream");
  if (!value) return new Response("File sách bị thiếu, xóa rồi gửi lại nhé", { status: 410 });
  // Stream thẳng từ KV (isolate chỉ có 128 MB); FixedLengthStream để trả Content-Length thật,
  // máy đọc hiện được tiến độ tải
  const { readable, writable } = new FixedLengthStream(row.size);
  value.pipeTo(writable).catch(() => undefined);
  return new Response(readable, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": contentDisposition(row.title, id),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}

/**
 * Gỡ sách: chuyển file vào hàng chờ xóa + xóa dòng trong một transaction (xóa song song chỉ một lần thắng),
 * rồi xóa file KV ngay. KV lỗi (thường là hết lượt xóa trong ngày) thì file nằm hàng chờ, dọn sau.
 */
export async function remove(env: Env, user: db.UserRow, id: string, ctx: ExecutionContext): Promise<Response> {
  const blobKey = await db.takeBook(env.DB, user.id, id, Date.now());
  if (!blobKey) return error(404, "Không có sách này");
  ctx.waitUntil(db.finishBlobDelete(env.DB, env.BOOKS, blobKey).catch(() => undefined));
  return json({ ok: true });
}
