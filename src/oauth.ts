/** Route đăng nhập bằng Google. Giao thức và kiểm token ở google.ts; tạo tài khoản / phiên dùng chung accounts.ts. */
import { admitSignup, createAccount, hasPassword, recheckPassword, signupOpen, startSession } from "./accounts";
import { SessionAuth, userFromSession } from "./auth";
import { newToken, timingSafeEqualStr } from "./crypto";
import * as db from "./db";
import { Env } from "./env";
import {
  PENDING_SECONDS,
  PROVIDER,
  authorizeUrl,
  exchangeCode,
  flowCookie,
  googleEnabled,
  newFlow,
  pendingCookie,
  pendingCookieName,
  pendingHash,
  readFlow,
  usernameCandidates,
} from "./google";
import { clientIp, error, json, readCookie, readJson } from "./http";
import { normalizeUsername, usernameError } from "./validate";

/** Mỗi IP tối đa ngần này lượt Google quay về trong 15 phút (mỗi lượt ghi D1: phiên hoặc chỗ giữ tên). */
const CALLBACK_MAX_PER_IP = 30;
const CALLBACK_WINDOW = 15 * 60;

/** Cấu hình công khai cho trang web (không đụng D1). */
export function config(env: Env): Response {
  return json({ google: googleEnabled(env), signup: signupOpen(env), needsCode: !!env.SIGNUP_CODE?.trim(), selfHost: env.SHOW_SELF_HOST === "1" });
}

/**
 * Bắt đầu: tạo state/PKCE/nonce, cất vào cookie HttpOnly, trả URL Google cho trang web tự chuyển tới.
 * Là POST cùng origin (không phải link GET) để trang khác không kích hoạt được luồng "liên kết".
 */
export async function start(req: Request, env: Env, url: URL, auth: SessionAuth | null): Promise<Response> {
  if (!googleEnabled(env)) return error(404, "Trang này chưa bật đăng nhập bằng Google");
  const body = await readJson(req);
  const mode = body?.mode === "link" ? "link" : "login";
  if (mode === "link") {
    if (!auth) return error(401, "Cần đăng nhập");
    // Gắn Google = thêm một cách đăng nhập: phiên bị trộm không được tự gắn Google của kẻ trộm
    if (hasPassword(auth.user)) {
      const bad = await recheckPassword(env, auth, body?.proof);
      if (bad) return bad;
    }
  }
  const flow = newFlow(mode, mode === "link" ? auth!.user.id : undefined);
  return json({ url: await authorizeUrl(env, url, flow) }, 200, { "Set-Cookie": flowCookie(url, flow) });
}

/** Google chuyển về đây. Luôn trả 303 về trang chủ kèm ?google=<kết quả> để trang web báo cho người dùng. */
export async function callback(req: Request, env: Env, url: URL): Promise<Response> {
  const flow = readFlow(req, url);
  const cookies = [flowCookie(url, null)];
  const done = (status: string) => {
    const res = new Response(null, { status: 303, headers: { Location: `/?google=${status}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    for (const c of cookies) res.headers.append("Set-Cookie", c);
    return res;
  };
  if (!googleEnabled(env)) return done("off");
  if (url.searchParams.has("error")) return done("cancel");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!flow || !code || code.length > 2048 || !timingSafeEqualStr(state, flow.s)) return done("expired");
  const n = await db.hitAttempt(env.DB, `google:ip:${clientIp(req)}`, Math.floor(Date.now() / 1000), CALLBACK_WINDOW);
  if (n > CALLBACK_MAX_PER_IP) return done("slow");

  const id = await exchangeCode(env, url, code, flow);
  if (!id) return done("error");
  const owner = await db.identityUserId(env.DB, PROVIDER, id.sub);

  if (flow.m === "link") {
    // Phiên phải còn là người đã bấm "Liên kết" (không gắn nhầm vào tài khoản khác đăng nhập chen giữa)
    const auth = await userFromSession(env.DB, req, url);
    if (!auth || auth.user.id !== flow.u) return done("expired");
    if (owner) return done(owner === auth.user.id ? "linked" : "taken");
    const r = await db.linkIdentity(env.DB, PROVIDER, id.sub, auth.user.id, Date.now());
    return done(r === "ok" ? "linked" : r);
  }

  if (owner) {
    const user = await db.getUserById(env.DB, owner);
    if (!user) return done("error");
    const res = done("ok");
    await startSession(req, env, url, user, res);
    return res;
  }

  // Google mới: giữ chỗ, để người dùng chọn tên đăng nhập (tên này gõ trên máy đọc sách nên để họ quyết)
  if (!signupOpen(env)) return done("closed");
  const suggest = (await db.firstFreeUsername(env.DB, usernameCandidates(id.email))) ?? "";
  const token = newToken();
  await db.putPending(
    env.DB,
    { token_hash: await pendingHash(token), provider: PROVIDER, subject: id.sub, suggest, expires_at: Date.now() + PENDING_SECONDS * 1000 },
    Date.now(),
  );
  cookies.push(pendingCookie(url, token));
  return done("pick");
}

async function readPending(req: Request, env: Env, url: URL): Promise<db.PendingRow | null> {
  const token = readCookie(req, pendingCookieName(url));
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return db.getPending(env.DB, await pendingHash(token), Date.now());
}

/** Trang web hỏi: có đang chờ chọn tên không, gợi ý tên gì. */
export async function pendingInfo(req: Request, env: Env, url: URL): Promise<Response> {
  if (!googleEnabled(env)) return error(404, "Trang này chưa bật đăng nhập bằng Google");
  const p = await readPending(req, env, url);
  if (!p) return error(404, "Không có đăng ký Google nào đang chờ");
  return json({ suggest: p.suggest, needsCode: !!env.SIGNUP_CODE?.trim() });
}

/** Chọn tên xong → tạo tài khoản gắn Google (không mật khẩu). */
export async function signup(req: Request, env: Env, url: URL): Promise<Response> {
  if (!googleEnabled(env)) return error(404, "Trang này chưa bật đăng nhập bằng Google");
  const p = await readPending(req, env, url);
  if (!p) return error(410, "Hết thời gian chọn tên, bấm Đăng nhập bằng Google lại nhé");
  const body = await readJson(req);
  if (!body) return error(400, "Dữ liệu không hợp lệ");
  const username = normalizeUsername(body.username);
  const uErr = usernameError(username);
  if (uErr) return error(400, uErr);
  const admit = await admitSignup(req, env, body.code);
  if ("error" in admit) return admit.error;
  return createAccount(
    env,
    url,
    { username, password: null, identity: { provider: p.provider, subject: p.subject }, pendingHash: p.token_hash },
    admit.giveBack,
    [pendingCookie(url, "")],
  );
}

/** Bỏ chọn tên (người dùng bấm Hủy). */
export function cancelPending(url: URL): Response {
  return json({ ok: true }, 200, { "Set-Cookie": pendingCookie(url, "") });
}

/** Gỡ Google khỏi tài khoản — chỉ khi tài khoản có mật khẩu (không thì mất đường đăng nhập). */
export async function unlink(env: Env, auth: SessionAuth): Promise<Response> {
  if (!hasPassword(auth.user)) return error(400, "Tài khoản này chỉ đăng nhập bằng Google, không gỡ được");
  await db.unlinkIdentity(env.DB, auth.user.id, PROVIDER);
  return json({ ok: true });
}
