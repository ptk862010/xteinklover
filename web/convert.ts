import { marked } from "marked";
import { EpubInput, buildEpub, escapeXml } from "./epub";
import { cleanTree, serialize } from "./html";
import type { Progress } from "./images";
import type { PdfMode } from "./pdf";

export interface ConvertResult {
  bytes: Uint8Array;
  title: string;
  author: string;
  /** Ghi chú cho người dùng, vd "PDF → ảnh trang, 120 trang" */
  note?: string;
}

export interface ConvertOptions {
  author?: string;
  lang?: string;
  title?: string;
  fallbackTitle?: string;
  pdfMode?: PdfMode;
  onProgress?: Progress;
}

const TEXT_EXTS = ["md", "markdown", "txt", "html", "htm"];
/** Sách Kindle / Mobipocket (không DRM) */
const MOBI_EXTS = ["mobi", "prc", "azw", "azw3", "kf8"];
/** Mọi đuôi nhận được — app.js dùng cho ô chọn file */
export const ACCEPT_EXTS = ["epub", ...MOBI_EXTS, "pdf", "cbz", ...TEXT_EXTS];

const BLOCK = /<(p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr|div|img|br|em|strong|code|a|del|input)\b/;

function htmlToXhtml(html: string) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root")!;
  // Ảnh ngoài mạng: máy không tải được → để chú thích chữ
  const headings = cleanTree(root, doc, { images: "text" });
  root.removeAttribute("id");
  return { body: serialize(root), headings };
}

function stripFrontmatter(md: string): { body: string; title?: string; author?: string } {
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: md };
  const get = (k: string) => m[1].match(new RegExp("^" + k + ":[ ]*['\"]?(.+?)['\"]?[ ]*$", "m"))?.[1]?.trim();
  return { body: md.slice(m[0].length), title: get("title"), author: get("author") };
}

function titleFromHtml(html: string, fallback: string): string {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() || fallback : fallback;
}

/** md / txt / html → EPUB. */
async function convertText(file: File, ext: string, name: string, opts: ConvertOptions): Promise<ConvertResult> {
  // Ký tự điều khiển (trừ tab, xuống dòng) không hợp lệ trong XHTML của EPUB
  const text = new TextDecoder().decode(await file.arrayBuffer()).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, "");
  let html: string;
  let title = name;
  let author = opts.author ?? "";
  if (ext === "html" || ext === "htm") {
    html = text.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
    title = opts.title || text.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() || name;
  } else if (ext === "md" || ext === "markdown") {
    const fm = stripFrontmatter(text);
    html = await marked.parse(fm.body, { gfm: true, breaks: false });
    title = opts.title || fm.title || titleFromHtml(html, opts.fallbackTitle || name);
    author = fm.author || author;
  } else {
    title = opts.title || opts.fallbackTitle || name;
    html = text
      .split(/\r?\n\r?\n/)
      .map((p) => `<p>${escapeXml(p).replace(/\r?\n/g, "<br/>")}</p>`)
      .join("\n");
  }
  const { body, headings } = htmlToXhtml(html);
  if (!BLOCK.test(html)) throw new Error("File rỗng hoặc không đọc được");
  const input: EpubInput = {
    title,
    author: author || undefined,
    lang: opts.lang ?? "vi",
    bodyXhtml: body,
    images: [],
    headings,
    identifier: `urn:xteinklover:${Date.now().toString(36)}`,
    date: new Date().toISOString(),
  };
  return { bytes: await buildEpub(input), title, author };
}

/**
 * Mọi định dạng → EPUB ngay trên trình duyệt (máy chủ không tốn CPU). EPUB thì gửi nguyên.
 * MOBI/PDF/CBZ nạp thư viện riêng khi cần (PDF.js ~3 MB chỉ tải lúc có người gửi PDF).
 */
export async function convertFile(file: File, opts: ConvertOptions = {}): Promise<ConvertResult> {
  const name = file.name.replace(/\.[^.]+$/, "");
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ACCEPT_EXTS.includes(ext)) {
    const hint = ext === "cbr" ? " (CBR là RAR — nén lại thành .cbz)" : ext === "docx" || ext === "doc" ? " (Word: lưu thành .html hoặc PDF rồi gửi)" : "";
    throw new Error(`Chưa hỗ trợ .${ext || "?"}${hint}`);
  }
  if (ext === "epub") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!isZip) throw new Error("File .epub hỏng (không phải ZIP)");
    return { bytes, title: opts.title || name, author: opts.author ?? "" };
  }
  if (MOBI_EXTS.includes(ext)) {
    const { convertMobi } = await import("./mobi");
    return convertMobi(file, opts, opts.onProgress);
  }
  if (ext === "pdf") {
    const { convertPdf } = await import("./pdf");
    const r = await convertPdf(file, { ...opts, mode: opts.pdfMode }, opts.onProgress);
    return { ...r, note: r.mode === "image" ? `ảnh trang, ${r.pages} trang` : `chữ, ${r.pages} trang` };
  }
  if (ext === "cbz") {
    const { convertCbz } = await import("./cbz");
    const r = await convertCbz(file, opts, opts.onProgress);
    return { ...r, note: `${r.pages} trang` };
  }
  return convertText(file, ext, name, opts);
}

/** PDF sẽ được chuyển kiểu gì ở chế độ Tự chọn, và bao nhiêu trang. */
export async function probePdf(file: File) {
  const { probePdf } = await import("./pdf");
  return probePdf(file);
}

declare global {
  interface Window {
    XteinkConvert: { convertFile: typeof convertFile; probePdf: typeof probePdf; accept: string[] };
  }
}
window.XteinkConvert = { convertFile, probePdf, accept: ACCEPT_EXTS };
