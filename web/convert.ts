import { marked } from "marked";
import { EpubHeading, EpubInput, buildEpub, escapeXml } from "./epub";

export interface ConvertResult {
  bytes: Uint8Array;
  title: string;
  author: string;
}

const BLOCK = /<(p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr|div|img|br|em|strong|code|a|del|input)\b/;

function htmlToXhtml(html: string): { body: string; headings: EpubHeading[] } {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root")!;
  root.querySelectorAll("script, style, iframe, video, audio, svg, button, form").forEach((n) => n.remove());
  // Ảnh ngoài: máy không tải được → để tên
  root.querySelectorAll("img").forEach((img) => img.replaceWith(doc.createTextNode(`(ảnh: ${img.getAttribute("alt") || img.getAttribute("src") || ""})`)));
  root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((b) => b.replaceWith(doc.createTextNode(b.checked ? "☑ " : "☐ ")));
  root.querySelectorAll("a").forEach((a) => {
    if (!/^https?:\/\//.test(a.getAttribute("href") ?? "")) a.replaceWith(doc.createTextNode(a.textContent ?? ""));
  });
  const headings: EpubHeading[] = [];
  root.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((h, i) => {
    h.id = `h${i + 1}`;
    headings.push({ id: h.id, level: Number(h.tagName[1]), text: h.textContent?.trim() || `Mục ${i + 1}` });
  });
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    for (const attr of Array.from(el.attributes)) if (!["href", "id", "class", "colspan", "rowspan", "start"].includes(attr.name)) el.removeAttribute(attr.name);
  }
  return { body: new XMLSerializer().serializeToString(root), headings };
}

function stripFrontmatter(md: string): { body: string; title?: string; author?: string } {
  const m = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: md };
  const get = (k: string) => m[1].match(new RegExp("^" + k + ":[ ]*['\"]?(.+?)['\"]?[ ]*$", "m"))?.[1]?.trim();
  return { body: md.slice(m[0].length), title: get("title"), author: get("author") };
}

function titleFromHtml(html: string, fallback: string): string {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() || fallback : fallback;
}

/** md / txt / html → EPUB ngay trên trình duyệt. EPUB thì trả nguyên. */
export async function convertFile(file: File, opts: { author?: string; lang?: string } = {}): Promise<ConvertResult> {
  const name = file.name.replace(/\.[^.]+$/, "");
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === "epub" || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return { bytes, title: name, author: opts.author ?? "" };

  const text = new TextDecoder().decode(bytes);
  let html: string;
  let title = name;
  let author = opts.author ?? "";
  if (ext === "html" || ext === "htm") {
    html = text.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
    title = text.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() || name;
  } else if (ext === "md" || ext === "markdown") {
    const fm = stripFrontmatter(text);
    html = await marked.parse(fm.body, { gfm: true, breaks: false });
    title = fm.title || titleFromHtml(html, name);
    author = fm.author || author;
  } else {
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

declare global {
  interface Window {
    XteinkConvert: { convertFile: typeof convertFile };
  }
}
window.XteinkConvert = { convertFile };
