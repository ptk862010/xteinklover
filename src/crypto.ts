/**
 * Mật khẩu băm hai tầng, kiểu Bitwarden, vì Workers free chỉ có 10 ms CPU/request
 * (PBKDF2 100k vòng ≈ 40 ms, production còn chặn cứng trên 100k vòng):
 *   1. Trình duyệt: proof = PBKDF2-SHA256(mật khẩu, "xteinklover|v1|" + username, 600k vòng) — xem public/app.js.
 *      Mật khẩu thật không rời trình duyệt.
 *   2. Server: PBKDF2-SHA256(proof, salt ngẫu nhiên, SERVER_ITERATIONS) — rẻ, chống lộ proof khi lộ DB.
 * Khóa OPDS và phiên đăng nhập là chuỗi ngẫu nhiên dài → chỉ cần SHA-256.
 */

const enc = new TextEncoder();

/** Vòng băm phía server. Production Workers chặn > 100_000; giữ nhỏ để nằm trong 10 ms CPU. */
export const SERVER_ITERATIONS = 2_000;
/** Tham số phía trình duyệt, lưu kèm mỗi tài khoản để sau này nâng cấp được. */
export const CLIENT_KDF = "pbkdf2-sha256-600000-v1";

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("hex không hợp lệ");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Bảng chữ dễ gõ trên máy đọc sách: bỏ 0/O, 1/l/I. */
const KEY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Khóa ngẫu nhiên dạng xxxx-xxxx-xxxx-xxxx (~78 bit), để gõ tay trên Xteink. */
export function newReadableKey(groups = 4, size = 4): string {
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = "";
    // Loại bias modulo: chỉ nhận byte < 248 (= 31*8)
    while (s.length < size) {
      for (const b of randomBytes(size * 2)) {
        if (b < 248 && s.length < size) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
      }
    }
    parts.push(s);
  }
  return parts.join("-");
}

/** Token phiên: 32 byte ngẫu nhiên, hex. */
export function newToken(): string {
  return toHex(randomBytes(32));
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** So sánh độ dài cố định, không dừng sớm. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export interface PasswordHash {
  hash: string; // hex
  salt: string; // hex
  iterations: number;
}

/** `proof` là 64 ký tự hex do trình duyệt tính từ mật khẩu. */
export async function hashProof(proof: string, iterations = SERVER_ITERATIONS, saltHex?: string): Promise<PasswordHash> {
  const salt = saltHex ? fromHex(saltHex) : randomBytes(16);
  const key = await crypto.subtle.importKey("raw", enc.encode(proof), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt), iterations };
}

export async function verifyProof(proof: string, stored: PasswordHash): Promise<boolean> {
  const got = await hashProof(proof, stored.iterations, stored.salt);
  return timingSafeEqualStr(got.hash, stored.hash);
}
