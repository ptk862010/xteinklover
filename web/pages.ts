// Sách "ảnh trang": mỗi trang là một ảnh xám vừa màn 480×800 (PDF scan, sách nhiều hình, truyện tranh CBZ).
import { EpubChapter, EpubImage, buildEpub } from "./epub";
import { SCREEN_H, SCREEN_W, drawToJpeg } from "./images";

/** Trần file gửi lên (server nhận tối đa 20 MB). */
export const MAX_EPUB_BYTES = 19.5 * 1024 * 1024;

export class PageBook {
  readonly images: EpubImage[] = [];
  readonly chapters: EpubChapter[] = [];
  private total = 0;

  /**
   * Thêm một trang. Trang ngang (rộng hơn cao) xoay 90° để lấp đầy màn dọc.
   * Nguồn nên có độ phân giải ≥ 2× màn hình để thu nhỏ cho nét.
   */
  async add(source: CanvasImageSource & { width: number; height: number }, quality = 0.72): Promise<void> {
    let src: CanvasImageSource & { width: number; height: number } = source;
    if (source.width > source.height * 1.15) {
      const c = document.createElement("canvas");
      c.width = source.height;
      c.height = source.width;
      const ctx = c.getContext("2d")!;
      ctx.translate(c.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(source, 0, 0);
      src = c;
    }
    const jpg = await drawToJpeg(src, { maxW: SCREEN_W, maxH: SCREEN_H, quality, gray: true });
    if (src !== source) (src as HTMLCanvasElement).width = 0;
    this.total += jpg.bytes.length;
    if (this.total > MAX_EPUB_BYTES) {
      throw new Error(`Quá ${Math.round(MAX_EPUB_BYTES / 1048576)} MB sau ${this.chapters.length} trang — tách file nhỏ hơn (hoặc PDF chữ thì chọn chế độ "Chữ")`);
    }
    const n = this.chapters.length + 1;
    const href = `images/p${n}.jpg`;
    this.images.push({ href, bytes: jpg.bytes, mediaType: "image/jpeg" });
    // Mục lục: mốc mỗi 10 trang, đủ để nhảy nhanh mà không dài quá
    this.chapters.push({ title: n === 1 || n % 10 === 0 ? `Trang ${n}` : undefined, bodyXhtml: `<img src="${href}" alt=""/>`, headings: [] });
  }

  get pages(): number {
    return this.chapters.length;
  }

  build(meta: { title: string; author?: string; lang: string; id: string }): Promise<Uint8Array> {
    if (!this.chapters.length) throw new Error("Không có trang nào");
    return buildEpub({
      title: meta.title,
      author: meta.author,
      lang: meta.lang,
      chapters: this.chapters,
      images: this.images,
      coverHref: this.images[0].href,
      fixedPages: true,
      identifier: meta.id,
      date: new Date().toISOString(),
    });
  }
}

/** Sắp tên file tự nhiên: 2.jpg trước 10.jpg. */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
