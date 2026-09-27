/**
 * Vá hai thứ Cloudflare Workers có mà Node không có, để code trong src/ chạy nguyên xi:
 * - crypto.subtle.digest("MD5"): KOReader dùng MD5 (mã tài liệu, mật khẩu KOSync); WebCrypto của Node bỏ MD5.
 * - FixedLengthStream: stream biết trước độ dài, để server trả Content-Length (máy đọc hiện được % tải).
 */
import { createHash } from "node:crypto";

const lengths = new WeakMap<ReadableStream, number>();

/** Độ dài đã khai của body tạo từ FixedLengthStream (không phải thì undefined). */
export function declaredLength(body: ReadableStream | null): number | undefined {
  return body ? lengths.get(body) : undefined;
}

export class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number | bigint) {
    const n = Number(expected);
    let seen = 0;
    super({
      transform(chunk, c) {
        seen += chunk.byteLength;
        if (seen > n) c.error(new Error(`FixedLengthStream: dài hơn ${n} byte`));
        else c.enqueue(chunk);
      },
      flush(c) {
        if (seen !== n) c.error(new Error(`FixedLengthStream: có ${seen}/${n} byte`));
      },
    });
    lengths.set(this.readable, n);
  }
}

function bytesOf(data: BufferSource): Buffer {
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data as ArrayBuffer);
}

function algName(alg: AlgorithmIdentifier): string {
  return (typeof alg === "string" ? alg : alg.name).toUpperCase();
}

let installed = false;

/** Gọi một lần trước khi nạp worker. */
export function installRuntime(): void {
  if (installed) return;
  installed = true;
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: (alg: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
      if (algName(alg) !== "MD5") return digest(alg, data);
      const d = createHash("md5").update(bytesOf(data)).digest();
      return Promise.resolve(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
    },
  });
  const g = globalThis as { FixedLengthStream?: unknown };
  if (!g.FixedLengthStream) g.FixedLengthStream = FixedLengthStream;
}
