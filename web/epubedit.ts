/**
 * Ghi tên, tác giả mới vào content.opf của EPUB (trên trình duyệt — Worker không đủ CPU để giải nén / nén lại).
 * JSZip giữ nguyên dữ liệu đã nén của các file khác, chỉ nén lại OPF; mimetype vẫn đứng đầu, không nén.
 */
import JSZip from "jszip";
import { escapeXml } from "./epub";

export interface MetaEdit {
  title: string;
  author: string;
}

const CREATOR = /[ \t]*<(dc:)?creator\b([^>]*)>[\s\S]*?<\/(dc:)?creator>[ \t]*\r?\n?/gi;

function isAuthorRole(attrs: string): boolean {
  const role = attrs.match(/\brole\s*=\s*["']([^"']*)["']/i)?.[1];
  return !role || role.toLowerCase() === "aut";
}

/** Thay dc:title đầu tiên, gom mọi tác giả (không vai trò hoặc vai trò aut) thành một; giữ người dịch, biên tập… */
export function setOpfMeta(opf: string, m: MetaEdit): string {
  const title = escapeXml(m.title);
  const author = escapeXml(m.author);
  let out = opf;
  let hasTitle = false;
  out = out.replace(/<(dc:)?title\b([^>]*)>[\s\S]*?<\/(dc:)?title>/i, (_all, p = "", attrs: string) => {
    hasTitle = true;
    return `<${p}title${attrs}>${title}</${p}title>`;
  });
  let placed = false;
  out = out.replace(CREATOR, (all, p = "", attrs: string) => {
    if (!isAuthorRole(attrs)) return all;
    if (placed || !author) return "";
    placed = true;
    const indent = all.match(/^[ \t]*/)?.[0] ?? "";
    const tail = all.match(/\r?\n?$/)?.[0] ?? "";
    return `${indent}<${p}creator>${author}</${p}creator>${tail}`;
  });
  const insert = [hasTitle ? "" : `<dc:title>${title}</dc:title>`, placed || !author ? "" : `<dc:creator>${author}</dc:creator>`].filter(Boolean);
  if (insert.length) {
    // Chưa có tên / tác giả: chèn sau dc:title (nếu có) hoặc ngay đầu <metadata>
    if (hasTitle && insert.length === 1 && !insert[0].startsWith("<dc:title")) {
      out = out.replace(/(<(dc:)?title\b[^>]*>[\s\S]*?<\/(dc:)?title>)/i, `$1\n    ${insert[0]}`);
    } else {
      out = out.replace(/(<(opf:)?metadata\b[^>]*>)/i, `$1\n    ${insert.join("\n    ")}`);
    }
  }
  return out;
}

export async function rewriteEpubMeta(bytes: Uint8Array, m: MetaEdit): Promise<Uint8Array> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("File không phải EPUB (không mở được ZIP)");
  }
  const container = await zip.file("META-INF/container.xml")?.async("text");
  const opfPath = container?.match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i)?.[1];
  const opfFile = opfPath ? zip.file(opfPath) : null;
  if (!opfPath || !opfFile) throw new Error("File không phải EPUB (thiếu content.opf)");
  zip.file(opfPath, setOpfMeta(await opfFile.async("text"), m));
  // Ghi lại mimetype để chắc chắn không nén (JSZip giữ vị trí cũ: mục đầu tiên)
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "application/epub+zip" });
}
