/** Kiểm tra dữ liệu người dùng gửi lên. Trả về thông báo lỗi tiếng Việt, hoặc null nếu hợp lệ. */

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const PROOF_RE = /^[0-9a-f]{64}$/;

/** Tên đăng nhập: chữ thường không dấu, số, . _ - ; 3–32 ký tự; không bắt đầu/kết thúc bằng dấu. */
export function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function usernameError(u: string): string | null {
  if (u.length < 3 || u.length > 32) return "Tên đăng nhập dài 3–32 ký tự";
  if (!USERNAME_RE.test(u)) return "Tên đăng nhập chỉ gồm chữ thường không dấu, số và . _ -";
  if (RESERVED.has(u)) return "Tên này đã được giữ, chọn tên khác";
  return null;
}

/**
 * Server chỉ nhận `proof` (hash do trình duyệt tính), không thấy mật khẩu thật.
 * Luật độ dài mật khẩu (PASSWORD_MIN/MAX) kiểm ở trình duyệt, app.js.
 */
export function isProof(p: unknown): p is string {
  return typeof p === "string" && PROOF_RE.test(p);
}

const RESERVED = new Set(["admin", "root", "api", "opds", "books", "login", "logout", "signup", "support", "xteink", "xteinklover", "system"]);

/** Chuỗi hiển thị: gộp khoảng trắng, bỏ ký tự điều khiển và ký tự XML không cho phép (U+FFFE/FFFF, surrogate lẻ), cắt độ dài. */
export function cleanText(v: unknown, fallback: string, max = 200): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, " ").trim().replace(/\s+/g, " ") : "";
  // Cắt theo ký tự (code point) để không cắt đôi emoji thành ký tự hỏng
  return Array.from(s || fallback).slice(0, max).join("");
}
