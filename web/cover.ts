// Ảnh bìa cho kệ web: JPEG màu thu nhỏ (khác ảnh trong sách: ảnh trong sách là thang xám cho e-ink).
import { EpubMeta, readEpubMeta } from "./epubmeta";
import { drawToJpeg } from "./images";

/** Thẻ sách rộng ~160 px, màn hình nét gấp đôi → 320 × 480 là đủ, ~20–40 KB. */
const THUMB_W = 320;
const THUMB_H = 480;

/** Ảnh hỏng, không giải mã được hoặc bé quá (icon) thì trả undefined — không bao giờ ném lỗi. */
export async function makeThumb(blob: Blob): Promise<Uint8Array | undefined> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return undefined;
  }
  try {
    if (bmp.width < 40 || bmp.height < 40) return undefined;
    return (await drawToJpeg(bmp, { maxW: THUMB_W, maxH: THUMB_H, quality: 0.82, gray: false })).bytes;
  } catch {
    return undefined;
  } finally {
    bmp.close();
  }
}

/** Metadata + ảnh bìa thu nhỏ của một file EPUB (sách mới gửi, hoặc sách cũ tải lại từ kệ). */
export async function readEpub(bytes: Uint8Array, coverBlob?: Blob): Promise<EpubMeta & { thumb?: Uint8Array }> {
  const meta = readEpubMeta(bytes);
  const blob = coverBlob ?? (meta.cover ? new Blob([meta.cover.bytes as Uint8Array<ArrayBuffer>], { type: meta.cover.mediaType }) : undefined);
  const { cover: _drop, ...rest } = meta;
  return { ...rest, thumb: blob ? await makeThumb(blob) : undefined };
}
