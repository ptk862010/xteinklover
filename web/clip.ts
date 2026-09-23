// Link bài viết → EPUB. Server chỉ lấy hộ trang (vượt CORS); cắt nội dung chính bằng Readability (Apache-2.0)
// và dựng EPUB ngay trên trình duyệt.
import { Readability } from "@mozilla/readability";
import { EpubImage, buildEpub, escapeXml } from "./epub";
import { cleanTree, serialize } from "./html";
import { Progress, blobToEinkJpeg } from "./images";

/** Ảnh tối đa mỗi bài (mỗi ảnh là một lượt tải qua server) */
const MAX_IMAGES = 20;

export interface ClipResult {
  bytes: Uint8Array;
  title: string;
  author: string;
  note: string;
}

async function apiError(r: Response): Promise<Error> {
  const msg = await r
    .json()
    .then((j) => (j as { error?: string }).error)
    .catch(() => undefined);
  return Object.assign(new Error(msg || `Lỗi ${r.status}`), { status: r.status });
}

/** Giải mã theo charset của header; không có thì xem thẻ <meta charset> ở đầu trang; mặc định UTF-8. */
export function decodeHtml(bytes: Uint8Array, headerCharset: string): string {
  let charset = headerCharset.trim().toLowerCase();
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset = head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1]?.toLowerCase() ?? "utf-8";
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Ảnh lazy-load (data-src…) → src thật; <picture><source> thì bỏ, giữ <img>. */
export function fixLazyImages(doc: Document): void {
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src") || img.getAttribute("data-srcset")?.split(/[\s,]+/)[0];
    const src = img.getAttribute("src") ?? "";
    if (lazy && (!src || src.startsWith("data:") || /blank|placeholder|spacer|1x1/i.test(src))) img.setAttribute("src", lazy);
  }
  doc.querySelectorAll("picture source").forEach((s) => s.remove());
}

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string }> {
  const r = await fetch("/api/fetch-page", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw await apiError(r);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { html: decodeHtml(bytes, r.headers.get("X-Charset") ?? ""), finalUrl: r.headers.get("X-Final-Url") || url };
}

async function fetchImage(src: string): Promise<Blob | null> {
  try {
    const r = await fetch("/api/fetch-image?url=" + encodeURIComponent(src), { credentials: "same-origin" });
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

export async function clipUrl(url: string, onProgress?: (msg: string) => void): Promise<ClipResult> {
  onProgress?.("Đang lấy trang…");
  const { html, finalUrl } = await fetchPage(url);
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Link tương đối trong bài (ảnh, link) tính theo địa chỉ trang gốc
  const base = doc.createElement("base");
  base.setAttribute("href", finalUrl);
  doc.head.insertBefore(base, doc.head.firstChild);
  fixLazyImages(doc);

  onProgress?.("Đang cắt lấy nội dung chính…");
  const article = new Readability(doc, { charThreshold: 300 }).parse();
  if (!article?.content || (article.textContent ?? "").trim().length < 200) {
    throw new Error("Không tìm thấy nội dung bài viết ở link này. Mở bài trên trình duyệt, copy rồi dán vào tab “Dán văn bản”");
  }
  const title = (article.title || new URL(finalUrl).hostname).trim().slice(0, 200);
  const author = (article.byline || "").trim().slice(0, 200);

  const body = new DOMParser().parseFromString(`<div id="r">${article.content}</div>`, "text/html");
  const root = body.getElementById("r")!;
  const headings = cleanTree(root, body, { images: "keep" });
  root.removeAttribute("id");

  // Ảnh: tải qua server (vượt CORS), thu nhỏ xám cho màn e-ink; ảnh không tải được thì bỏ
  const images: EpubImage[] = [];
  const imgs = Array.from(root.querySelectorAll("img"));
  let tried = 0;
  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    let href: string | null = null;
    if (/^https?:\/\//i.test(src) && tried < MAX_IMAGES) {
      tried++;
      onProgress?.(`Đang tải ảnh ${tried}/${Math.min(imgs.length, MAX_IMAGES)}…`);
      const blob = await fetchImage(src);
      const jpg = blob && (await blobToEinkJpeg(blob));
      if (jpg) {
        href = `images/c${images.length + 1}.jpg`;
        images.push({ href, bytes: jpg.bytes, mediaType: "image/jpeg" });
      }
    }
    if (href) img.setAttribute("src", href);
    else img.remove();
  }

  const site = article.siteName || new URL(finalUrl).hostname;
  const source = `<p class="source"><i>${escapeXml(site)} · <a href="${escapeXml(finalUrl)}">${escapeXml(finalUrl)}</a></i></p>`;
  onProgress?.("Đang đóng gói EPUB…");
  const bytes = await buildEpub({
    title,
    author: author || undefined,
    lang: (article.lang || doc.documentElement.lang || "vi").slice(0, 16).replace(/[^A-Za-z0-9-]/g, "") || "vi",
    chapters: [{ bodyXhtml: source + serialize(root), headings }],
    images,
    identifier: `urn:xteinklover:clip:${Date.now().toString(36)}`,
    date: new Date().toISOString(),
  });
  return { bytes, title, author, note: images.length ? `bài viết, ${images.length} ảnh` : "bài viết" };
}

/** Dán từ trang web (clipboard có text/html) → Markdown, giữ tiêu đề, danh sách, link, đậm nghiêng. */
export async function htmlToMarkdown(html: string): Promise<string> {
  const { default: TurndownService } = await import("turndown");
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.remove(["script", "style", "noscript", "iframe", "form", "button"]);
  return td.turndown(html).trim();
}

export type { Progress };
