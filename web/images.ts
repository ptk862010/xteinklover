/**
 * Ảnh cho máy e-ink: JPEG baseline (CrossPoint không hiện JPEG progressive/GIF), thang xám, thu nhỏ vừa màn hình.
 * Canvas.toBlob("image/jpeg") của trình duyệt luôn ra baseline.
 */

/** Màn X4: 480 × 800. */
export const SCREEN_W = 480;
export const SCREEN_H = 800;

export interface JpegOut {
  bytes: Uint8Array;
  width: number;
  height: number;
}

function toGray(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Nền trong suốt thành trắng, rồi quy về độ sáng
    const a = d[i + 3] / 255;
    const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
    d[i] = d[i + 1] = d[i + 2] = y;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

async function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!blob) throw new Error("Không nén được ảnh");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Vẽ nguồn (ảnh/ canvas) vào khung tối đa maxW × maxH, giữ tỉ lệ, không phóng to. */
export async function drawToJpeg(
  source: CanvasImageSource & { width: number; height: number },
  opts: { maxW: number; maxH: number; quality?: number; gray?: boolean },
): Promise<JpegOut> {
  const scale = Math.min(1, opts.maxW / source.width, opts.maxH / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: opts.gray !== false })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  if (opts.gray !== false) toGray(ctx, width, height);
  const bytes = await canvasToJpeg(canvas, opts.quality ?? 0.8);
  canvas.width = canvas.height = 0; // trả bộ nhớ sớm (điện thoại)
  return { bytes, width, height };
}

/** Ảnh trong sách (minh họa, bìa): tối đa 800 px mỗi chiều. Ảnh hỏng/không giải mã được thì trả null. */
export async function blobToEinkJpeg(blob: Blob, maxSide = 800): Promise<JpegOut | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    return await drawToJpeg(bmp, { maxW: maxSide, maxH: maxSide, quality: 0.8 });
  } finally {
    bmp.close();
  }
}

/** Nhỏ gọn cho giao diện: "Trang 3/120". */
export type Progress = (done: number, total: number) => void;
