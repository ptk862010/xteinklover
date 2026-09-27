/**
 * Đọc tên, tác giả, ngôn ngữ, ISBN và ảnh bìa ngay trong file EPUB (content.opf), không cần DOM:
 * chạy được trên trình duyệt lẫn trong test Node. Chỉ giải nén đúng mấy file cần (container, OPF, ảnh bìa),
 * không bung cả cuốn 20 MB. File hỏng hay thiếu thứ gì thì bỏ qua thứ đó, không ném lỗi.
 */
import { strFromU8, unzipSync } from "fflate";

export interface EpubMeta {
  title?: string;
  author?: string;
  lang?: string;
  isbn?: string;
  cover?: { bytes: Uint8Array; mediaType: string };
}

/** Tên do phần mềm tự điền, không phải tên sách thật */
const JUNK = /^(unknown|untitled|không tên|khong ten|no title|microsoft word\b|document\d*$|book\d*$|ebook\d*$)/i;

function unzipOne(bytes: Uint8Array, path: string): Uint8Array | undefined {
  try {
    return unzipSync(bytes, { filter: (f) => f.name === path })[path];
  } catch {
    return undefined;
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e as string]!)
    .replace(/\s+/g, " ")
    .trim();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

/** Mọi thẻ <dc:name> (có hoặc không tiền tố dc:) kèm thuộc tính và chữ bên trong. */
function dcAll(opf: string, name: string): { attrs: Record<string, string>; text: string }[] {
  const re = new RegExp(`<(?:dc:)?${name}\\b([^>]*)>([\\s\\S]*?)</(?:dc:)?${name}>`, "gi");
  return [...opf.matchAll(re)].map((m) => ({ attrs: attrs(m[1]), text: decodeXml(m[2]) })).filter((x) => x.text);
}

export function isIsbn(s: string): boolean {
  if (/^\d{13}$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  return false;
}

/** ISBN trong dc:identifier. Bỏ mã khai scheme khác (uuid, calibre…) dù trông giống ISBN. */
function findIsbn(opf: string): string | undefined {
  for (const id of dcAll(opf, "identifier")) {
    const scheme = (id.attrs["opf:scheme"] ?? id.attrs.scheme ?? "").toLowerCase();
    if (scheme && scheme !== "isbn") continue;
    const raw = id.text.replace(/^urn:isbn:/i, "").replace(/[\s-]/g, "").toUpperCase();
    if (isIsbn(raw)) return raw;
  }
  return undefined;
}

function resolvePath(base: string, href: string): string {
  let rel = href.split("#")[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* để nguyên */
  }
  const parts = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

type Item = Record<string, string>;

/** Bìa theo thứ tự: EPUB 3 cover-image → EPUB 2 <meta name="cover"> → ảnh có chữ "cover" trong id/href. */
function findCoverItem(opf: string): Item | undefined {
  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const isImage = (it: Item) => /^image\//i.test(it["media-type"] ?? "");
  const byProp = items.find((it) => /\bcover-image\b/.test(it.properties ?? ""));
  if (byProp) return byProp;
  const meta = [...opf.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0])).find((a) => a.name?.toLowerCase() === "cover" && a.content);
  if (meta) {
    const hit = items.find((it) => it.id === meta.content) ?? items.find((it) => it.href === meta.content);
    if (hit) return hit;
  }
  return items.find((it) => isImage(it) && /cover/i.test(`${it.id ?? ""} ${it.href ?? ""}`));
}

function goodText(s: string | undefined): string | undefined {
  return s && !JUNK.test(s) ? s : undefined;
}

export function readEpubMeta(bytes: Uint8Array): EpubMeta {
  const container = unzipOne(bytes, "META-INF/container.xml");
  if (!container) return {};
  const opfPath = strFromU8(container).match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i)?.[1];
  const opfBytes = opfPath && unzipOne(bytes, opfPath);
  if (!opfPath || !opfBytes) return {};
  const opf = strFromU8(opfBytes);
  const meta: EpubMeta = {};

  meta.title = goodText(dcAll(opf, "title")[0]?.text);
  const creators = dcAll(opf, "creator");
  const authors = creators.filter((c) => {
    const role = (c.attrs["opf:role"] ?? c.attrs.role ?? "aut").toLowerCase();
    return role === "aut";
  });
  meta.author = goodText((authors.length ? authors : creators.slice(0, 1)).map((c) => c.text).join(", ") || undefined);
  meta.lang = dcAll(opf, "language")[0]?.text.toLowerCase().split(/[-_]/)[0] || undefined;
  meta.isbn = findIsbn(opf);

  const item = findCoverItem(opf);
  if (item?.href) {
    const path = resolvePath(opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "", item.href);
    const img = unzipOne(bytes, path);
    if (img?.length) meta.cover = { bytes: img, mediaType: item["media-type"] || "image/jpeg" };
  }
  for (const k of Object.keys(meta) as (keyof EpubMeta)[]) if (meta[k] === undefined) delete meta[k];
  return meta;
}
