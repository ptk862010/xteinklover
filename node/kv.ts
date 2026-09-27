/**
 * KV chạy trên một thư mục: mỗi khóa là một file. Chỉ đủ phần API mà src/ dùng: get / put / delete.
 * Tên file mã hóa từ khóa (khóa như "b:abc" có dấu hai chấm, Windows không cho) nên không thể thoát ra ngoài thư mục.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

type Value = string | ArrayBuffer | ArrayBufferView | ReadableStream;
type GetType = "text" | "json" | "arrayBuffer" | "stream";

/** Chỉ giữ chữ, số, "_" và "-"; còn lại (kể cả "." và "/") thành %XX. */
export function fileNameForKey(key: string): string {
  if (!key) throw new Error("KV: khóa rỗng");
  return Array.from(new TextEncoder().encode(key), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_-]/.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }).join("");
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function toBytes(value: Value): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export class DirKV {
  private tmpSeq = 0;
  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<DirKV> {
    await mkdir(dir, { recursive: true });
    return new DirKV(dir);
  }

  private path(key: string): string {
    return join(this.dir, fileNameForKey(key));
  }

  async get(key: string, type: GetType | { type: GetType } = "text"): Promise<unknown> {
    const t = typeof type === "string" ? type : type.type;
    const p = this.path(key);
    try {
      if (t === "stream") {
        // Hỏi trước để khóa không có thì trả null ngay (không để lỗi nổ giữa lúc stream)
        await stat(p);
        return Readable.toWeb(createReadStream(p)) as ReadableStream;
      }
      const buf = await readFile(p);
      if (t === "arrayBuffer") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const text = new TextDecoder().decode(buf);
      return t === "json" ? JSON.parse(text) : text;
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  /** Ghi ra file tạm rồi đổi tên: đang ghi dở mà tắt máy thì file cũ vẫn nguyên. */
  async put(key: string, value: Value): Promise<void> {
    const p = this.path(key);
    const tmp = `${p}.tmp-${process.pid}-${++this.tmpSeq}`;
    try {
      await writeFile(tmp, await toBytes(value));
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  /** Ép kiểu sang KVNamespace cho các hàm trong src/. */
  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
