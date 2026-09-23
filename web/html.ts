import type { EpubHeading } from "./epub";

const DROP = "script, style, link, meta, iframe, video, audio, object, embed, form, button, input:not([type=checkbox]), select, textarea, noscript, template";
const KEEP_ATTRS = new Set(["href", "id", "colspan", "rowspan", "start", "src", "alt"]);
/** Thẻ HTML cũ của MOBI: bỏ thẻ, giữ chữ bên trong */
const UNWRAP = new Set(["font", "center", "basefont", "big", "span"]);

export interface CleanOptions {
  /** Ảnh: "text" = thay bằng chú thích chữ (ảnh ngoài mạng máy không tải được); "keep" = giữ <img src> để người gọi thay đường dẫn. */
  images: "text" | "keep";
  /** Tiền tố id cho tiêu đề (chương khác nhau không trùng id). */
  idPrefix?: string;
}

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

/**
 * Dọn một cây HTML thành nội dung XHTML an toàn cho EPUB: bỏ script/style/form, bỏ thuộc tính lạ,
 * link nội bộ thành chữ, thẻ có namespace (mbp:…) và thẻ trình bày cũ thì bỏ vỏ, đánh id cho h1–h3.
 */
export function cleanTree(root: Element, doc: Document, opts: CleanOptions): EpubHeading[] {
  root.querySelectorAll(DROP).forEach((n) => n.remove());
  // SVG bọc ảnh (sách Kindle KF8): giữ ảnh bên trong, bỏ phần SVG còn lại
  root.querySelectorAll("svg").forEach((svg) => {
    const im = svg.querySelector("image");
    const href = im?.getAttribute("href") || im?.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (href && opts.images === "keep") {
      const img = doc.createElement("img");
      img.setAttribute("src", href);
      svg.replaceWith(img);
    } else svg.remove();
  });
  if (opts.images === "text") {
    root.querySelectorAll("img").forEach((img) => img.replaceWith(doc.createTextNode(`(ảnh: ${img.getAttribute("alt") || img.getAttribute("src") || ""})`)));
  }
  root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((b) => b.replaceWith(doc.createTextNode(b.checked ? "☑ " : "☐ ")));
  root.querySelectorAll("a").forEach((a) => {
    if (!/^https?:\/\//.test(a.getAttribute("href") ?? "")) unwrap(a);
  });
  // Bỏ vỏ thẻ có namespace (không khai báo được trong XHTML) và thẻ trình bày cũ; đi từ trong ra ngoài
  for (const el of Array.from(root.querySelectorAll("*")).reverse()) {
    const tag = el.tagName.toLowerCase();
    if (tag.includes(":") || UNWRAP.has(tag)) unwrap(el);
  }
  const headings: EpubHeading[] = [];
  const prefix = opts.idPrefix ?? "h";
  root.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((h, i) => {
    const text = h.textContent?.replace(/\s+/g, " ").trim();
    h.id = `${prefix}${i + 1}`;
    if (text) headings.push({ id: h.id, level: Number(h.tagName[1]), text: text.slice(0, 120) });
  });
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (!KEEP_ATTRS.has(attr.name) || (attr.name === "src" && el.tagName !== "IMG")) el.removeAttribute(attr.name);
    }
  }
  return headings;
}

/** Nội dung có chữ hoặc ảnh không (bỏ chương rỗng). */
export function hasContent(root: Element): boolean {
  return (root.textContent ?? "").trim().length > 0 || !!root.querySelector("img");
}

export function serialize(root: Element): string {
  return new XMLSerializer().serializeToString(root);
}
