export interface Env {
  DB: D1Database;
  BOOKS: KVNamespace;
  ASSETS: Fetcher;
  CATALOG_TITLE?: string;
  MAX_UPLOAD_MB?: string;
  /** Tối đa bao nhiêu tài khoản (0 = không giới hạn). Tự cài một người: đặt 1. */
  MAX_USERS?: string;
  /** Mã mời: có đặt thì đăng ký phải nhập đúng. Không đặt thì đăng ký bị đóng, trừ khi OPEN_SIGNUP = "1". */
  SIGNUP_CODE?: string;
  /** "1" = ai cũng đăng ký được không cần mã (bản hosted công khai). */
  OPEN_SIGNUP?: string;
  /** Số tài khoản mới tối đa mỗi ngày, cả hệ thống (chặn một người đăng ký hàng loạt). */
  MAX_SIGNUPS_PER_DAY?: string;
  MAX_BOOKS_PER_USER?: string;
  MAX_STORAGE_MB_PER_USER?: string;
  /** Trần dung lượng cả hệ thống (KV free: 1 GB). */
  MAX_STORAGE_MB_TOTAL?: string;
  MAX_UPLOADS_PER_DAY?: string;
  /** Trần tải lên của cả hệ thống mỗi ngày (KV free: 1.000 ghi/ngày). */
  MAX_UPLOADS_PER_DAY_TOTAL?: string;
  /** Đăng nhập bằng Google: Client ID (var) + Client secret (secret). Thiếu một trong hai thì tắt. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Chỉ dùng cho test tích hợp: token endpoint giả trên máy local. */
  GOOGLE_TOKEN_URL?: string;
  /** Chỉ dùng cho test tích hợp: cho "Dán link" lấy trang từ 127.0.0.1 / localhost. */
  FETCH_ALLOW_LOCAL?: string;
}

export interface Limits {
  maxUploadBytes: number;
  maxUsers: number;
  maxSignupsPerDay: number;
  maxBooksPerUser: number;
  maxStoragePerUser: number;
  maxStorageTotal: number;
  maxUploadsPerDay: number;
  maxUploadsPerDayTotal: number;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const MB = 1024 * 1024;
/** KV giới hạn 25 MiB/value — không cho đặt quá. */
const KV_VALUE_MAX = 25 * MB;
/** Khớp LIST_LIMIT trong db.ts: web liệt kê tối đa từng này cuốn một lần. */
const BOOKS_PER_USER_MAX = 500;

export function limits(env: Env): Limits {
  return {
    maxUploadBytes: Math.min(num(env.MAX_UPLOAD_MB, 20) * MB, KV_VALUE_MAX),
    maxUsers: num(env.MAX_USERS, 0),
    maxSignupsPerDay: num(env.MAX_SIGNUPS_PER_DAY, 20),
    maxBooksPerUser: Math.min(num(env.MAX_BOOKS_PER_USER, 300), BOOKS_PER_USER_MAX),
    maxStoragePerUser: num(env.MAX_STORAGE_MB_PER_USER, 200) * MB,
    maxStorageTotal: num(env.MAX_STORAGE_MB_TOTAL, 900) * MB,
    maxUploadsPerDay: num(env.MAX_UPLOADS_PER_DAY, 50),
    maxUploadsPerDayTotal: num(env.MAX_UPLOADS_PER_DAY_TOTAL, 900),
  };
}
