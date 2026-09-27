/**
 * Sắp xếp kệ: sửa thông tin sách, tầng (nhãn — một cuốn nằm được nhiều tầng), dấu "Lên máy", thay file đã sửa.
 * "Chưa phân loại" và "Theo tác giả" là cách xem trên trình duyệt, không lưu gì thêm.
 */
import { uploadKeyAll, uploadKeyUser } from "./accounts";
import * as db from "./db";
import { Env, limits } from "./env";
import { error, json, readJson } from "./http";
import { koreaderHash } from "./kohash";
import { newBookId } from "./opds";
import { cleanText } from "./validate";

const HOUR = 3600;
const DAY = 86400;
export const EDITS_PER_HOUR = 600;
export const SHELVES_PER_USER = 50;
const SHELF_NAME_MAX = 40;
const SHELF_ID_RE = /^[a-z0-9]{1,32}$/;
const BAD = "Dữ liệu không hợp lệ";
const FINISHED_MIN = Date.UTC(2000, 0, 1);

function isIsbn(s: string): boolean {
  if (/^\d{13}$/.test(s)) return [...s].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
  if (/^\d{9}[\dX]$/.test(s)) return [...s].reduce((a, c, i) => a + (c === "X" ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
  return false;
}

export function parseShelfName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = cleanText(v, "", 200);
  return name && Array.from(name).length <= SHELF_NAME_MAX ? name : null;
}

/** Body của PATCH /api/books/:id → phần sửa cho bảng books + danh sách tầng (nếu có), hoặc thông báo lỗi. */
export function parseBookPatch(body: unknown, now = Date.now()): { patch: db.BookPatch; shelves: string[] | undefined } | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return BAD;
  const b = body as Record<string, unknown>;
  const patch: db.BookPatch = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") return BAD;
    const t = cleanText(b.title, "");
    if (!t) return "Tên sách không được để trống";
    patch.title = t;
  }
  if (b.author !== undefined) {
    if (typeof b.author !== "string") return BAD;
    patch.author = cleanText(b.author, "");
  }
  if (b.isbn !== undefined) {
    if (typeof b.isbn !== "string") return BAD;
    const isbn = b.isbn.replace(/[\s-]/g, "").toUpperCase();
    if (isbn && !isIsbn(isbn)) return "ISBN không hợp lệ";
    patch.isbn = isbn;
  }
  if (b.onDevice !== undefined) {
    if (typeof b.onDevice !== "boolean") return BAD;
    patch.on_device = b.onDevice ? 1 : 0;
  }
  if (b.finished !== undefined) {
    // 0 = bỏ đánh dấu; còn lại là mốc ms từ năm 2000 tới mai (lệch múi giờ)
    const f = b.finished;
    if (typeof f !== "number" || !Number.isInteger(f) || (f !== 0 && (f < FINISHED_MIN || f > now + 2 * 86400_000))) return "Ngày đọc xong không hợp lệ";
    patch.finished_at = f;
  }
  let shelves: string[] | undefined;
  if (b.shelves !== undefined) {
    if (!Array.isArray(b.shelves) || !b.shelves.every((s) => typeof s === "string" && SHELF_ID_RE.test(s))) return BAD;
    shelves = [...new Set(b.shelves as string[])];
    if (shelves.length > 1) return "Mỗi cuốn chỉ nằm ở một tầng";
  }
  if (b.fetched !== undefined) {
    // Web vừa chép thẳng file xuống máy đọc (bản tự chạy, File Transfer của CrossPoint)
    if (b.fetched !== true) return BAD;
    patch.fetched_at = now;
  }
  return { patch, shelves };
}

async function underEditLimit(env: Env, user: db.UserRow): Promise<boolean> {
  return (await db.hitAttempt(env.DB, `edit:user:${user.id}`, Math.floor(Date.now() / 1000), HOUR)) <= EDITS_PER_HOUR;
}
const tooMany = () => error(429, "Sửa quá nhiều, thử lại sau");

/** PATCH /api/books/:id {title?, author?, isbn?, onDevice?, finished?, shelves?: [] | [id], fetched?: true} — chỉ sửa trên kệ, không đụng file. */
export async function patchBook(req: Request, env: Env, user: db.UserRow, id: string): Promise<Response> {
  const parsed = parseBookPatch(await readJson(req));
  if (typeof parsed === "string") return error(400, parsed);
  if (!(await underEditLimit(env, user))) return tooMany();
  if (!(await db.updateBookMeta(env.DB, user.id, id, parsed.patch))) return error(404, "Không có sách này");
  if (parsed.shelves && !(await db.setBookShelves(env.DB, user.id, id, parsed.shelves))) return error(404, "Không có sách này");
  return json({ ok: true });
}

export async function listShelves(env: Env, user: db.UserRow): Promise<Response> {
  return json((await db.listShelves(env.DB, user.id)).map((s) => ({ id: s.id, name: s.name, count: s.count })));
}

/** POST /api/shelves {name} */
export async function createShelf(req: Request, env: Env, user: db.UserRow): Promise<Response> {
  const name = parseShelfName((await readJson(req))?.name);
  if (!name) return error(400, `Tên tầng dài 1–${SHELF_NAME_MAX} ký tự`);
  if (!(await underEditLimit(env, user))) return tooMany();
  const id = newBookId();
  const r = await db.createShelf(env.DB, { id, user_id: user.id, name, created_at: Date.now() }, SHELVES_PER_USER);
  if (r === "exists") return error(409, "Đã có tầng tên này");
  if (r === "full") return error(403, `Tối đa ${SHELVES_PER_USER} tầng`);
  return json({ id, name, count: 0 }, 201);
}

/** PATCH /api/shelves/:id {name} */
export async function renameShelf(req: Request, env: Env, user: db.UserRow, id: string): Promise<Response> {
  const name = parseShelfName((await readJson(req))?.name);
  if (!name) return error(400, `Tên tầng dài 1–${SHELF_NAME_MAX} ký tự`);
  if (!(await underEditLimit(env, user))) return tooMany();
  const r = await db.renameShelf(env.DB, user.id, id, name);
  if (r === "missing") return error(404, "Không có tầng này");
  if (r === "exists") return error(409, "Đã có tầng tên này");
  return json({ ok: true });
}

export async function deleteShelf(env: Env, user: db.UserRow, id: string): Promise<Response> {
  return (await db.deleteShelf(env.DB, user.id, id)) ? json({ ok: true }) : error(404, "Không có tầng này");
}

/**
 * PUT /api/books/:id/file — thay file EPUB (trình duyệt đã ghi tên / tác giả mới vào OPF).
 * Tốn một lượt ghi KV như gửi sách mới nên tính vào lượt gửi trong ngày. KV lỗi thì trả lại kích thước cũ.
 */
export async function replaceFile(req: Request, env: Env, user: db.UserRow, id: string, ctx: ExecutionContext): Promise<Response> {
  const lim = limits(env);
  const len = Number(req.headers.get("Content-Length") || NaN);
  if (!Number.isFinite(len)) return error(411, "Thiếu Content-Length");
  if (len > lim.maxUploadBytes) return error(413, "File quá lớn");
  const old = await db.getBook(env.DB, user.id, id);
  if (!old) return error(404, "Không có sách này");

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const counters: [string, number][] = [
    [uploadKeyUser(user.id, now), DAY],
    [uploadKeyAll(now), DAY],
  ];
  const overQuota = () => error(429, "Hôm nay đã hết lượt gửi, mai sửa tiếp nhé");
  // Xem trước (không ghi) để khỏi đọc cả file 20 MB khi đã hết lượt
  const [seenUser, seenAll] = await db.peekAttempts(env.DB, counters, nowSec);
  if (seenUser >= lim.maxUploadsPerDay || seenAll >= lim.maxUploadsPerDayTotal) return overQuota();

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return error(400, "Tải lên bị ngắt, thử lại");
  }
  const isZip = bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip || bytes.length > lim.maxUploadBytes) return error(415, "Chỉ nhận EPUB");

  const [perUser, perAll] = await db.hitAttempts(env.DB, counters, nowSec);
  const giveBack = () => ctx.waitUntil(Promise.allSettled(counters.map(([k]) => db.unhitAttempt(env.DB, k))).then(() => undefined));
  if (perUser > lim.maxUploadsPerDay || perAll > lim.maxUploadsPerDayTotal) {
    giveBack();
    return overQuota();
  }

  const hash = await koreaderHash(bytes);
  const r = await db.replaceBookFile(env.DB, user.id, id, bytes.length, hash, lim.maxStoragePerUser, lim.maxStorageTotal);
  if (r !== "ok") {
    giveBack();
    if (r === "missing") return error(404, "Không có sách này");
    return r === "store_full" ? error(507, "Kho chung đã đầy") : error(403, "Kệ đã đầy, xóa bớt rồi sửa tiếp");
  }
  try {
    await env.BOOKS.put(old.blob_key, bytes);
  } catch (e) {
    // File trên KV vẫn là bản cũ: trả lại kích thước, mã, và lúc máy tải (máy vẫn giữ đúng bản đó)
    const back = Number.MAX_SAFE_INTEGER;
    await db.replaceBookFile(env.DB, user.id, id, old.size, old.ko_hash ?? null, back, back, old.fetched_at ?? 0).catch(() => undefined);
    giveBack();
    throw e;
  }
  // Sách bị xóa (hoặc tài khoản bị xóa) trong lúc đang ghi → file thành mồ côi, cho vào hàng chờ xóa (như lúc gửi mới)
  await db.queueIfOrphan(env.DB, { id, blob_key: old.blob_key, size: bytes.length }, Date.now()).catch(() => undefined);
  return json({ ok: true, size: bytes.length });
}

/** Cron: tính mã KOReader cho sách gửi trước khi có tính năng này (đọc lại file từ KV, vài cuốn mỗi giờ). */
export async function backfillKoHash(env: Env, limit = 2): Promise<void> {
  for (const b of await db.booksMissingHash(env.DB, limit)) {
    // Đánh dấu "đã thử" (chuỗi rỗng) TRƯỚC khi đọc file: lần chạy bị cắt giữa chừng (hết CPU) hay file mất
    // thì cuốn đó không bị thử lại mãi — chỉ là không hiện được tiến độ đọc
    await db.setKoHash(env.DB, b.id, "");
    const buf = await env.BOOKS.get(b.blob_key, "arrayBuffer");
    if (buf) await db.setKoHash(env.DB, b.id, await koreaderHash(new Uint8Array(buf)));
  }
}
