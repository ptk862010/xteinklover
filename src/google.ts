/**
 * Đăng nhập bằng Google (OpenID Connect, luồng authorization code + PKCE).
 * Bật khi chủ trang đặt GOOGLE_CLIENT_ID (var) và GOOGLE_CLIENT_SECRET (secret).
 *
 * Chỉ lưu mã định danh Google (`sub`), không lưu email hay tên. Email chỉ dùng một lần để gợi ý tên đăng nhập.
 * id_token nhận thẳng từ token endpoint của Google qua HTTPS nên không cần kiểm chữ ký (OIDC Core 3.1.3.7),
 * chỉ kiểm iss / aud / exp / nonce — không phải tải khóa JWKS, rẻ CPU.
 */
import { sha256Hex, toHex, randomBytes } from "./crypto";
import { Env } from "./env";
import { readCookie } from "./http";
import { USERNAME_RE, usernameError } from "./validate";

export const PROVIDER = "google";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** Luồng đăng nhập phải xong trong ngần này (cookie state hết hạn). */
export const FLOW_SECONDS = 10 * 60;
/** Chọn tên đăng nhập sau khi Google xác nhận: giữ chỗ ngần này. */
export const PENDING_SECONDS = 15 * 60;

export type FlowMode = "login" | "link";

export interface FlowState {
  /** state gửi Google, so khớp lúc quay về (chống CSRF đăng nhập) */
  s: string;
  /** PKCE code_verifier */
  v: string;
  /** nonce, phải nằm trong id_token */
  n: string;
  m: FlowMode;
  /** mode "link": user đang đăng nhập lúc bắt đầu */
  u?: string;
  /** thời điểm bắt đầu (ms) */
  t: number;
}

export function googleEnabled(env: Env): boolean {
  return !!env.GOOGLE_CLIENT_ID?.trim() && !!env.GOOGLE_CLIENT_SECRET?.trim();
}

export function redirectUri(url: URL): string {
  return `${url.origin}/auth/google/callback`;
}

/** Chỉ cho đổi token endpoint sang máy local (test tích hợp dùng server Google giả). */
function tokenUrl(env: Env): string {
  const t = env.GOOGLE_TOKEN_URL?.trim();
  return t && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(t) ? t : TOKEN_URL;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function newFlow(mode: FlowMode, userId: string | undefined, now = Date.now()): FlowState {
  return { s: toHex(randomBytes(16)), v: b64url(randomBytes(32)), n: toHex(randomBytes(16)), m: mode, ...(userId ? { u: userId } : {}), t: now };
}

export async function authorizeUrl(env: Env, url: URL, flow: FlowState): Promise<string> {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!.trim(),
    redirect_uri: redirectUri(url),
    response_type: "code",
    scope: "openid email",
    state: flow.s,
    nonce: flow.n,
    code_challenge: await pkceChallenge(flow.v),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${AUTH_URL}?${q}`;
}

// ── cookie giữ state trong lúc đi sang Google và quay về ──

export function flowCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-xl_oauth" : "xl_oauth";
}

/** SameSite=Lax: Google chuyển về bằng GET cấp cao nhất nên cookie vẫn được gửi. */
export function flowCookie(url: URL, flow: FlowState | null): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const value = flow ? b64url(new TextEncoder().encode(JSON.stringify(flow))) : "";
  return `${flowCookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${flow ? FLOW_SECONDS : 0}${secure}`;
}

export function readFlow(req: Request, url: URL, now = Date.now()): FlowState | null {
  const raw = readCookie(req, flowCookieName(url));
  if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const f = JSON.parse(b64urlDecode(raw)) as FlowState;
    const okStr = (x: unknown, re: RegExp) => typeof x === "string" && re.test(x);
    if (!okStr(f.s, /^[0-9a-f]{32}$/) || !okStr(f.v, /^[A-Za-z0-9_-]{43}$/) || !okStr(f.n, /^[0-9a-f]{32}$/)) return null;
    if (f.m !== "login" && f.m !== "link") return null;
    if (f.u !== undefined && !okStr(f.u, /^[0-9a-f-]{36}$/)) return null;
    if (typeof f.t !== "number" || now - f.t > FLOW_SECONDS * 1000 || f.t > now + 60_000) return null;
    return f;
  } catch {
    return null;
  }
}

/** Cookie giữ chỗ "đang chọn tên đăng nhập" sau khi Google xác nhận (token ngẫu nhiên, D1 lưu hash). */
export function pendingCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-xl_pending" : "xl_pending";
}

export function pendingCookie(url: URL, token: string): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${pendingCookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? PENDING_SECONDS : 0}${secure}`;
}

export const pendingHash = (token: string) => sha256Hex("pending:" + token);

// ── đổi code lấy id_token ──

export interface GoogleIdentity {
  sub: string;
  email?: string;
}

/** Kiểm các claim của id_token. Tách riêng để unit test. */
export function checkClaims(payload: Record<string, unknown>, clientId: string, nonce: string, nowSec: number): GoogleIdentity | null {
  if (!ISSUERS.has(String(payload.iss))) return null;
  const aud = payload.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) return null;
  if (Array.isArray(aud) && aud.length > 1 && payload.azp !== clientId) return null;
  if (typeof payload.exp !== "number" || payload.exp < nowSec - 60) return null;
  if (payload.nonce !== nonce) return null;
  if (typeof payload.sub !== "string" || !/^[0-9A-Za-z_-]{1,255}$/.test(payload.sub)) return null;
  // Chỉ gợi ý tên từ email đã xác minh
  const email = payload.email_verified === true && typeof payload.email === "string" ? payload.email : undefined;
  return { sub: payload.sub, email };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts[1].length > 8192) return null;
  try {
    const v = JSON.parse(b64urlDecode(parts[1]));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(env: Env, url: URL, code: string, flow: FlowState): Promise<GoogleIdentity | null> {
  const r = await fetch(tokenUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!.trim(),
      client_secret: env.GOOGLE_CLIENT_SECRET!.trim(),
      redirect_uri: redirectUri(url),
      grant_type: "authorization_code",
      code_verifier: flow.v,
    }),
  });
  if (!r.ok) {
    console.error("google token exchange failed", r.status);
    return null;
  }
  const data = (await r.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!data || typeof data.id_token !== "string") return null;
  const payload = decodeJwtPayload(data.id_token);
  return payload ? checkClaims(payload, env.GOOGLE_CLIENT_ID!.trim(), flow.n, Math.floor(Date.now() / 1000)) : null;
}

// ── gợi ý tên đăng nhập ──

/** "Phạm.Trung_Kiên+abc@gmail.com" → "pham.trung_kien". Trả về "" nếu không dựng được tên hợp lệ. */
export function usernameBase(email: string | undefined): string {
  const local = (email ?? "").split("@")[0].split("+")[0];
  let s = local
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 28)
    .replace(/[._-]+$/g, "");
  if (s.length < 3) s = s ? s + "reader" : "";
  return s && USERNAME_RE.test(s) ? s : "";
}

/** Các tên ứng viên theo thứ tự ưu tiên: base, base2 … base9 (hoặc "reader" + số ngẫu nhiên nếu không có email). */
export function usernameCandidates(email: string | undefined, rand = () => Math.floor(Math.random() * 9000) + 1000): string[] {
  const base = usernameBase(email);
  const list = base ? [base, ...Array.from({ length: 8 }, (_, i) => base + (i + 2))] : [];
  for (let i = 0; i < 3; i++) list.push("reader" + rand());
  return list.filter((u) => !usernameError(u));
}
