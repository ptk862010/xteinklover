/**
 * Bìa sách trên kệ web.
 * - Ảnh bìa thu nhỏ (JPEG ~30 KB, trình duyệt tự làm) lưu trong D1, không tốn lượt ghi KV (1.000/ngày).
 * - Tìm bìa trên mạng: Worker gọi Google Books (giữ kín GOOGLE_BOOKS_KEY) rồi Open Library, trả danh sách để
 *   người dùng chọn. Chỉ trả địa chỉ ảnh; trình duyệt tự tải ảnh qua /api/fetch-image rồi thu nhỏ.
 */
import * as db from "./db";
import { Env } from "./env";
import { error, json } from "./http";
import { cleanText } from "./validate";

export const COVER_MAX_BYTES = 200 * 1024;
const HOUR = 3600;
export const COVER_PUTS_PER_HOUR = 200;
export const COVER_SEARCHES_PER_HOUR = 60;
const SEARCH_TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 12;

export interface CoverCandidate {
  source: "google" | "openlibrary";
  title: string;
  authors: string;
  publisher?: string;
  year?: string;
  lang?: string;
  /** Ảnh cỡ lớn để làm bìa */
  image: string;
  /** Ảnh nhỏ để hiện trong danh sách chọn */
  thumb: string;
}

export interface SearchQuery {
  title: string;
  author: string;
  isbn?: string;
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

const squash = (s: string) => s.replace(/[_\s]+/g, " ").trim();

/**
 * Tên sách thường lấy từ tên file: bỏ phần trong ngoặc kiểu "(z-lib.org)", "[Ebook]"; tên dạng
 * "Tên - Tác giả" thì tách ra (chỉ khi gạch có khoảng trắng hai bên, "Spider-Man" giữ nguyên).
 */
export function cleanSearch(title: string, author: string): { title: string; author: string } {
  let t = squash(title.replace(/\[[^\]]*\]|\([^)]*\)/g, " "));
  let a = squash(author);
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    if (!a) {
      t = dash[1].trim();
      a = dash[2].trim();
    } else if (dash[2].trim().toLowerCase() === a.toLowerCase()) {
      t = dash[1].trim();
    }
  }
  return { title: t, author: a };
}

export function googleUrl(q: SearchQuery, key: string): string {
  const u = new URL("https://www.googleapis.com/books/v1/volumes");
  // Tìm theo từng từ: intitle:"cả cụm" hay trượt với tên tiếng Việt, từng từ thì vẫn chặt (mọi từ phải có trong tên)
  const each = (op: string, s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 10).map((w) => `${op}:${w}`);
  u.searchParams.set("q", q.isbn ? `isbn:${q.isbn}` : [...each("intitle", q.title), ...each("inauthor", q.author)].join(" "));
  u.searchParams.set("maxResults", "20");
  u.searchParams.set("printType", "books");
  u.searchParams.set("fields", "items(id,volumeInfo(title,authors,publisher,publishedDate,language,imageLinks/thumbnail))");
  if (key) u.searchParams.set("key", key);
  return u.toString();
}

const googleImage = (id: string, w: number) => `https://books.google.com/books/content?id=${id}&printsec=frontcover&img=1&zoom=1&fife=w${w}&source=gbs_api`;

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? cleanText(v, "", 160) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseGoogle(data: unknown): CoverCandidate[] {
  const items = (data as Json | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: CoverCandidate[] = [];
  for (const it of items as Json[]) {
    const id = typeof it?.id === "string" ? it.id : "";
    const v = (it?.volumeInfo ?? {}) as Json;
    // Không có imageLinks = Google không có bìa (ảnh trả về sẽ là ô "image not available")
    if (!/^[\w-]{6,24}$/.test(id) || !(v.imageLinks as Json | undefined)?.thumbnail) continue;
    out.push({
      source: "google",
      title: str(v.title),
      authors: cleanText(list(v.authors).join(", "), "", 160),
      publisher: str(v.publisher) || undefined,
      year: str(v.publishedDate).slice(0, 4) || undefined,
      lang: str(v.language).toLowerCase() || undefined,
      image: googleImage(id, 480),
      thumb: googleImage(id, 240),
    });
  }
  return out;
}

export function openLibraryUrl(q: SearchQuery): string {
  const u = new URL("https://openlibrary.org/search.json");
  if (q.isbn) u.searchParams.set("isbn", q.isbn);
  else {
    u.searchParams.set("title", q.title);
    if (q.author) u.searchParams.set("author", q.author);
  }
  u.searchParams.set("limit", "15");
  u.searchParams.set("fields", "title,author_name,publisher,first_publish_year,language,cover_i");
  return u.toString();
}

/** Open Library ghi ngôn ngữ bằng mã MARC 3 chữ */
const MARC: Record<string, string> = { eng: "en", vie: "vi", fre: "fr", ger: "de", spa: "es", ita: "it", jpn: "ja", chi: "zh", rus: "ru", por: "pt", kor: "ko" };

export function parseOpenLibrary(data: unknown): CoverCandidate[] {
  const docs = (data as Json | null)?.docs;
  if (!Array.isArray(docs)) return [];
  const out: CoverCandidate[] = [];
  for (const d of docs as Json[]) {
    const cover = d?.cover_i;
    if (typeof cover !== "number" || !Number.isInteger(cover) || cover <= 0) continue;
    const lang = list(d.language)[0];
    out.push({
      source: "openlibrary",
      title: str(d.title),
      authors: cleanText(list(d.author_name).join(", "), "", 160),
      publisher: list(d.publisher)[0] ? str(list(d.publisher)[0]) : undefined,
      year: typeof d.first_publish_year === "number" ? String(d.first_publish_year) : undefined,
      lang: lang ? MARC[lang] ?? lang : undefined,
      image: `https://covers.openlibrary.org/b/id/${cover}-L.jpg`,
      thumb: `https://covers.openlibrary.org/b/id/${cover}-M.jpg`,
    });
  }
  return out;
}

/** Từ trong tên, bỏ dấu tiếng Việt và hoa thường: "Hóa Thân" → ["hoa", "than"]. */
function words(s: string): string[] {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Tỉ lệ từ trong tên sách có mặt trong tên ứng viên, làm tròn về 3 mức để thứ tự nguồn vẫn có nghĩa. */
function titleMatch(query: string[], title: string): number {
  if (!query.length) return 0;
  const have = new Set(words(title));
  const r = query.filter((w) => have.has(w)).length / query.length;
  return r >= 0.99 ? 2 : r >= 0.5 ? 1 : 0;
}

/**
 * Bỏ trùng ảnh rồi xếp: tên khớp tên sách lên trước (Google hay trả cả sách khác cùng tác giả), rồi
 * cùng ngôn ngữ với sách, còn lại giữ thứ tự nguồn trả về. Sách dịch (tên khác hẳn) vẫn giữ, xếp sau.
 */
export function rankCandidates(items: CoverCandidate[], by: { title?: string; lang?: string } = {}, max = MAX_CANDIDATES): CoverCandidate[] {
  const seen = new Set<string>();
  const query = words(by.title ?? "");
  return items
    .filter((c) => !seen.has(c.image) && seen.add(c.image))
    .map((c, i) => ({ c, i, match: titleMatch(query, c.title), lang: by.lang && c.lang === by.lang ? 1 : 0 }))
    .sort((a, b) => b.match - a.match || b.lang - a.lang || a.i - b.i)
    .slice(0, max)
    .map((x) => x.c);
}

async function getJson(url: string): Promise<unknown> {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined);
      return null;
    }
    return await r.json();
  } catch {
    return null;
  }
}

async function rateLimit(env: Env, key: string, max: number): Promise<boolean> {
  return (await db.hitAttempt(env.DB, key, Math.floor(Date.now() / 1000), HOUR)) <= max;
}

/**
 * GET /api/covers/search?title=&author=&isbn=&lang= → { byIsbn, items }.
 * Google hết lượt / lỗi / chưa có key thì vẫn còn Open Library. Kết quả giữ trong Cache API một ngày.
 */
export async function search(env: Env, url: URL, user: db.UserRow): Promise<Response> {
  const isbnRaw = (url.searchParams.get("isbn") || "").replace(/[\s-]/g, "").toUpperCase();
  const isbn = /^(\d{13}|\d{9}[\dX])$/.test(isbnRaw) ? isbnRaw : undefined;
  const { title, author } = cleanSearch(cleanText(url.searchParams.get("title"), ""), cleanText(url.searchParams.get("author"), ""));
  if (!isbn && title.length < 2) return error(400, "Nhập tên sách để tìm");
  const lang = (url.searchParams.get("lang") || "").toLowerCase().slice(0, 3) || undefined;

  const q: SearchQuery = { title, author, isbn };
  // v: đổi cách tìm / xếp thì tăng lên để bỏ kết quả cũ trong cache
  const cacheKey = new Request(`https://cover-search.xteinklover.invalid/?${new URLSearchParams({ v: "2", t: title, a: author, i: isbn ?? "", l: lang ?? "" })}`);
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  const hit = await cache?.match(cacheKey).catch(() => undefined);
  if (hit) return json(await hit.json());
  // Chỉ tính lượt khi thật sự gọi ra Google / Open Library (kết quả có sẵn trong cache thì không tốn)
  if (!(await rateLimit(env, `cover:find:${user.id}`, COVER_SEARCHES_PER_HOUR))) return error(429, `Tối đa ${COVER_SEARCHES_PER_HOUR} lần tìm bìa mỗi giờ, thử lại sau`);

  const [google, ol] = await Promise.all([getJson(googleUrl(q, env.GOOGLE_BOOKS_KEY || "")), getJson(openLibraryUrl(q))]);
  const items = rankCandidates([...parseGoogle(google), ...parseOpenLibrary(ol)], { title: isbn ? "" : title, lang });
  const body = { byIsbn: Boolean(isbn), query: { title, author, isbn }, items };
  if (google !== null || ol !== null) {
    const res = new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" } });
    await cache?.put(cacheKey, res).catch(() => undefined);
  }
  return json(body);
}

/** PUT /api/books/:id/cover — body là JPEG thu nhỏ do trình duyệt làm. */
export async function put(req: Request, env: Env, user: db.UserRow, id: string): Promise<Response> {
  const len = Number(req.headers.get("Content-Length") || NaN);
  if (!Number.isFinite(len)) return error(411, "Thiếu Content-Length");
  if (len > COVER_MAX_BYTES) return error(413, "Ảnh bìa quá lớn");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return error(400, "Tải lên bị ngắt, thử lại");
  }
  if (bytes.length > COVER_MAX_BYTES) return error(413, "Ảnh bìa quá lớn");
  if (!isJpeg(bytes)) return error(415, "Ảnh bìa phải là JPEG");
  if (!(await rateLimit(env, `cover:put:${user.id}`, COVER_PUTS_PER_HOUR))) return error(429, "Đổi bìa quá nhiều, thử lại sau");
  const version = await db.setCover(env.DB, user.id, id, bytes, Date.now());
  if (version === null) return error(404, "Không có sách này");
  return json({ ok: true, cover: version });
}

/** GET /api/books/:id/cover?v= — địa chỉ đổi theo phiên bản nên cho trình duyệt giữ lâu. */
export async function get(env: Env, user: db.UserRow, id: string): Promise<Response> {
  const bytes = await db.getCover(env.DB, user.id, id);
  if (!bytes) return new Response("Không có bìa", { status: 404 });
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
