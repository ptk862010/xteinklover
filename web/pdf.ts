// PDF → EPUB trên trình duyệt bằng PDF.js (Apache-2.0). Hai chế độ:
//  - "text": rút chữ, dàn lại thành đoạn (sách chữ; đọc thoải mái, đổi cỡ chữ được)
//  - "image": mỗi trang thành một ảnh xám vừa màn (PDF scan, sách nhiều hình; giữ nguyên bố cục)
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { buildEpub } from "./epub";
import { SCREEN_H, SCREEN_W, Progress } from "./images";
import type { BookResult } from "./mobi";
import { PageBook } from "./pages";
import { Line, pageLines, toBlocks, toChapters } from "./pdftext";

export type PdfMode = "auto" | "text" | "image";

let workerReady = false;
function ensureWorker(): void {
  if (workerReady) return;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("/pdfjs/pdf.worker.min.mjs", location.origin).href;
  workerReady = true;
}

type Page = Awaited<ReturnType<PDFDocumentProxy["getPage"]>>;

async function textLines(page: Page): Promise<Line[]> {
  const tc = await page.getTextContent();
  return pageLines(tc.items.filter((it): it is TextItem => "str" in it).map((it) => ({ ...it, str: clean(it.str) })));
}

const IMAGE_OPS = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);

/**
 * Chế độ "Tự chọn": lấy mẫu tối đa 8 trang rải đều. Trang minh họa = có ảnh mà ít chữ (< 1.200 ký tự),
 * trang scan = gần như không có chữ. Từ 40% mẫu trở lên là trang minh họa/scan → ảnh trang; còn lại → chữ.
 * (Sách chữ có logo nhỏ mỗi trang vẫn nhiều chữ nên không bị nhầm.)
 */
async function guessMode(pdf: PDFDocumentProxy): Promise<"text" | "image"> {
  const n = pdf.numPages;
  const k = Math.min(8, n);
  const sample = [...new Set(Array.from({ length: k }, (_, i) => 1 + Math.floor(((i + 0.5) * n) / k)))];
  let visual = 0;
  for (const p of sample) {
    const page = await pdf.getPage(p);
    const chars = (await textLines(page)).reduce((t, l) => t + l.text.length, 0);
    let hasImage = false;
    if (chars < 1200) {
      const ops = await page.getOperatorList();
      hasImage = ops.fnArray.some((f) => IMAGE_OPS.has(f));
    }
    page.cleanup();
    if (chars < 80 || hasImage) visual++;
  }
  return visual / sample.length >= 0.4 ? "image" : "text";
}

async function openPdf(file: File): Promise<{ pdf: PDFDocumentProxy; task: PDFDocumentLoadingTask }> {
  ensureWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, wasmUrl: new URL("/pdfjs/wasm/", location.origin).href });
  try {
    return { pdf: await task.promise, task };
  } catch (e) {
    await task.destroy().catch(() => undefined);
    if ((e as { name?: string })?.name === "PasswordException") throw new Error("PDF có mật khẩu — mở khóa trước rồi gửi");
    throw new Error("Không đọc được PDF (file hỏng?)");
  }
}

/** Ký tự điều khiển không hợp lệ trong XHTML. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, "");

/** Đoán nhanh cách chuyển (không vẽ trang nào) — để báo trước cho người dùng. */
export async function probePdf(file: File): Promise<{ mode: "text" | "image"; pages: number }> {
  const { pdf, task } = await openPdf(file);
  try {
    return { mode: await guessMode(pdf), pages: pdf.numPages };
  } finally {
    await task.destroy();
  }
}

export async function convertPdf(
  file: File,
  opts: { title?: string; author?: string; lang?: string; mode?: PdfMode } = {},
  onProgress?: Progress,
): Promise<BookResult & { mode: "text" | "image"; pages: number }> {
  const { pdf, task } = await openPdf(file);
  try {
    const info = ((await pdf.getMetadata().catch(() => null))?.info ?? {}) as { Title?: string; Author?: string };
    const name = file.name.replace(/\.[^.]+$/, "");
    const title = opts.title || clean(String(info.Title || "")).trim() || name;
    const author = opts.author || clean(String(info.Author || "")).trim();
    const n = pdf.numPages;

    const mode = opts.mode && opts.mode !== "auto" ? opts.mode : await guessMode(pdf);
    const pages: Line[][] = [];
    if (mode === "text") {
      for (let p = 1; p <= n; p++) {
        onProgress?.(p - 1, n);
        const page = await pdf.getPage(p);
        pages.push(await textLines(page));
        page.cleanup();
      }
    }

    if (mode === "text") {
      const { blocks, pageStarts } = toBlocks(pages);
      if (!blocks.length) throw new Error("PDF không có chữ (bản scan) — chọn chế độ Ảnh trang");
      onProgress?.(n, n);
      const bytes = await buildEpub({
        title,
        author: author || undefined,
        lang: opts.lang ?? "vi",
        chapters: toChapters(blocks, pageStarts),
        images: [],
        identifier: `urn:xteinklover:pdf:${Date.now().toString(36)}`,
        date: new Date().toISOString(),
      });
      return { bytes, title, author, mode: "text", pages: n };
    }

    const book = new PageBook();
    for (let p = 1; p <= n; p++) {
      onProgress?.(p - 1, n);
      const page = await pdf.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const landscape = vp1.width > vp1.height * 1.15;
      // Vẽ ở ~2× màn hình rồi thu nhỏ cho chữ nét
      const fitW = (landscape ? SCREEN_H : SCREEN_W) * 2;
      const fitH = (landscape ? SCREEN_W : SCREEN_H) * 2;
      const viewport = page.getViewport({ scale: Math.min(fitW / vp1.width, fitH / vp1.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // intent "print": vẽ liền một mạch, không chờ requestAnimationFrame — tab ẩn (chuyển app trên điện thoại)
      // thì trình duyệt ngừng khung hình và việc vẽ sẽ treo
      await page.render({ canvas, viewport, background: "#ffffff", intent: "print" }).promise;
      page.cleanup();
      await book.add(canvas);
      canvas.width = canvas.height = 0;
    }
    onProgress?.(n, n);
    const bytes = await book.build({ title, author: author || undefined, lang: opts.lang ?? "vi", id: `urn:xteinklover:pdf:${Date.now().toString(36)}` });
    return { bytes, title, author, mode: "image", pages: n };
  } finally {
    await task.destroy();
  }
}
