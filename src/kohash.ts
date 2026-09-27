/**
 * Mã tài liệu kiểu KOReader ("Binary" document matching của KOSync, CrossPoint dùng cùng cách): MD5 của các mẫu
 * 1 KB ở vị trí 1024 << 2i với i = -1…10. LuaJIT chỉ lấy 5 bit của số lần dịch nên i = -1 cho vị trí 0:
 * 0, 1K, 4K, 16K, 64K, 256K, 1M, 4M, 16M… Dừng ở vị trí đầu tiên vượt quá cuối file; mẫu cuối có thể ngắn hơn 1 KB.
 * Máy chủ tính lúc nhận file để nối tiến độ đọc (bảng sync_progress) với sách trên kệ.
 */
export type Md5Bytes = (b: Uint8Array) => Promise<string>;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** MD5 có sẵn trong WebCrypto của Workers (ngoài chuẩn). Test trên Node truyền hàm khác vào. */
export const workersMd5Bytes: Md5Bytes = async (b) => toHex(await crypto.subtle.digest("MD5", b as Uint8Array<ArrayBuffer>));

export function koreaderSamples(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = -1; i <= 10; i++) {
    const off = i < 0 ? 0 : 1024 << (2 * i);
    if (off >= bytes.length) break;
    parts.push(bytes.subarray(off, off + 1024));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function koreaderHash(bytes: Uint8Array, md5: Md5Bytes = workersMd5Bytes): Promise<string> {
  return md5(koreaderSamples(bytes));
}
