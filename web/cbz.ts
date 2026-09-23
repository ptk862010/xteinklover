// CBZ (truyện tranh: ZIP chứa ảnh) → EPUB ảnh trang, mỗi ảnh một trang vừa màn 480×800.
import JSZip from "jszip";
import { Progress } from "./images";
import type { BookResult } from "./mobi";
import { PageBook, naturalCompare } from "./pages";

const IMAGE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

export async function convertCbz(file: File, opts: { title?: string; author?: string; lang?: string } = {}, onProgress?: Progress): Promise<BookResult & { pages: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("File CBZ hỏng (không phải ZIP). File .cbr (RAR) chưa hỗ trợ");
  }
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && IMAGE.test(f.name) && !/(^|\/)(__MACOSX|\.)/.test(f.name))
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!entries.length) throw new Error("Trong CBZ không có ảnh nào");

  // ComicInfo.xml (nếu có) cho tên truyện, tác giả
  let title = opts.title || file.name.replace(/\.[^.]+$/, "");
  let author = opts.author || "";
  const info = zip.file(/(^|\/)ComicInfo\.xml$/i)[0];
  if (info) {
    const xml = new DOMParser().parseFromString(await info.async("text"), "application/xml");
    const t = [xml.querySelector("Series")?.textContent, xml.querySelector("Number")?.textContent, xml.querySelector("Title")?.textContent].filter(Boolean).join(" · ");
    if (!opts.title && t) title = t;
    if (!opts.author) author = xml.querySelector("Writer")?.textContent || "";
  }

  const book = new PageBook();
  for (let i = 0; i < entries.length; i++) {
    onProgress?.(i, entries.length);
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(await entries[i].async("blob"));
    } catch {
      continue; // ảnh hỏng thì bỏ qua trang đó
    }
    try {
      await book.add(bmp, 0.75);
    } finally {
      bmp.close();
    }
  }
  onProgress?.(entries.length, entries.length);
  const bytes = await book.build({ title, author: author || undefined, lang: opts.lang ?? "vi", id: `urn:xteinklover:cbz:${Date.now().toString(36)}` });
  return { bytes, title, author, pages: book.pages };
}
