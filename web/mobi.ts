// MOBI / PRC / AZW / AZW3 (KF8) → EPUB ngay trên trình duyệt, dùng bộ đọc mobi.js của foliate-js (MIT).
import { unzlibSync } from "fflate";
import { MOBI } from "foliate-js/mobi.js";
import { EpubChapter, EpubImage, buildEpub } from "./epub";
import { cleanTree, hasContent, serialize } from "./html";
import { Progress, blobToEinkJpeg } from "./images";

export interface BookResult {
  bytes: Uint8Array;
  title: string;
  author: string;
}

/**
 * Đọc cờ mã hóa trong header PalmDOC (record 0, offset 12) mà không cần giải nén.
 * 0 = không DRM. Sách mua trên Kindle Store thường có DRM → không chuyển được.
 */
export function mobiEncryption(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  if (buf.byteLength < 86) throw new Error("File quá ngắn, không phải sách MOBI");
  const type = new TextDecoder("latin1").decode(new Uint8Array(buf, 60, 8));
  if (type !== "BOOKMOBI" && type !== "TEXtREAd") throw new Error("Không phải file MOBI/AZW hợp lệ");
  const rec0 = v.getUint32(78);
  if (rec0 + 14 > buf.byteLength) throw new Error("File MOBI hỏng");
  return v.getUint16(rec0 + 12);
}

async function blobFromUrl(url: string): Promise<Blob | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

export async function convertMobi(file: File, opts: { title?: string; author?: string; lang?: string } = {}, onProgress?: Progress): Promise<BookResult> {
  const buf = await file.arrayBuffer();
  const enc = mobiEncryption(buf);
  if (enc !== 0) throw new Error("Sách có DRM (mua từ Kindle Store) — không chuyển được. Chỉ nhận file MOBI/AZW không khóa");

  const book = await new MOBI({ unzlib: async (a: Uint8Array) => unzlibSync(a) }).open(file);
  const meta = book.metadata ?? {};
  const name = file.name.replace(/\.[^.]+$/, "");
  const title = opts.title || String(meta.title || "").trim() || name;
  const author = opts.author || (Array.isArray(meta.author) ? meta.author.filter(Boolean).join(", ") : String(meta.author || ""));

  const images: EpubImage[] = [];
  const imageByUrl = new Map<string, string | null>();
  async function addImage(url: string): Promise<string | null> {
    if (imageByUrl.has(url)) return imageByUrl.get(url)!;
    const blob = await blobFromUrl(url);
    const jpg = blob && (await blobToEinkJpeg(blob));
    const href = jpg ? `images/i${images.length + 1}.jpg` : null;
    if (jpg && href) images.push({ href, bytes: jpg.bytes, mediaType: "image/jpeg" });
    imageByUrl.set(url, href);
    return href;
  }

  // Bìa
  let coverHref: string | undefined;
  try {
    const cover: Blob | undefined = await book.getCover?.();
    if (cover) {
      const jpg = await blobToEinkJpeg(cover);
      if (jpg) {
        coverHref = "images/cover.jpg";
        images.push({ href: coverHref, bytes: jpg.bytes, mediaType: "image/jpeg" });
      }
    }
  } catch {
    /* không có bìa cũng được */
  }

  const sections = (book.sections as { load?: () => Promise<string>; linear?: string }[]).filter((s) => s.load && s.linear !== "no");
  const chapters: EpubChapter[] = [];
  const parser = new DOMParser();
  for (let i = 0; i < sections.length; i++) {
    onProgress?.(i, sections.length);
    const url = await sections[i].load!();
    const html = await (await fetch(url)).text();
    const doc = parser.parseFromString(html, "text/html");
    const root = doc.createElement("div");
    for (const n of Array.from(doc.body.childNodes)) root.appendChild(n);
    const headings = cleanTree(root, doc, { images: "keep", idPrefix: `c${i + 1}h` });
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      const href = src.startsWith("blob:") ? await addImage(src) : null;
      if (href) img.setAttribute("src", href);
      else img.remove();
    }
    if (!hasContent(root)) continue;
    chapters.push({ bodyXhtml: serialize(root), headings });
  }
  onProgress?.(sections.length, sections.length);
  if (!chapters.length) throw new Error("Không đọc được nội dung sách");

  const bytes = await buildEpub({
    title,
    author: author || undefined,
    lang: String(meta.language || opts.lang || "vi"),
    chapters,
    images,
    coverHref,
    identifier: `urn:xteinklover:mobi:${meta.identifier || Date.now().toString(36)}`,
    date: new Date().toISOString(),
  });
  return { bytes, title, author };
}
