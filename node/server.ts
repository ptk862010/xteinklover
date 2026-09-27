/**
 * Cầu nối Node http ↔ fetch handler của worker: đổi IncomingMessage thành Request, Response thành câu trả lời Node.
 * Giữ đúng những gì Cloudflare làm trước worker: đặt CF-Connecting-IP (client không giả được), bỏ body khi HEAD,
 * chặn body quá lớn, chạy nốt việc ctx.waitUntil.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Env } from "../src/env";
import { declaredLength } from "./runtime";

/**
 * "" = không tin header nào (mở thẳng ra mạng nhà);
 * "1" = sau reverse proxy (Caddy, nginx, Traefik): lấy IP từ X-Forwarded-For, giao thức từ X-Forwarded-Proto;
 * "cloudflare" = sau Cloudflare Tunnel: lấy IP từ CF-Connecting-IP.
 */
export type TrustProxy = "" | "1" | "cloudflare";

export interface BridgeOptions {
  worker: ExportedHandler<Env>;
  env: Env;
  trustProxy: TrustProxy;
  /** Ép địa chỉ gốc (vd. https://sach.example.com) khi proxy không chuyển Host. */
  publicUrl?: string;
  maxBodyBytes: number;
}

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/** Mục cuối của X-Forwarded-For: do proxy của mình thêm vào. Các mục trước do client tự ghi, giả được. */
function last(v: string | string[] | undefined): string {
  const all = (Array.isArray(v) ? v.join(",") : v ?? "").split(",");
  return all[all.length - 1]?.trim() ?? "";
}

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() ?? "";
}

export function clientIpOf(req: IncomingMessage, trust: TrustProxy): string {
  const fromHeader = trust === "1" ? last(req.headers["x-forwarded-for"]) : trust === "cloudflare" ? first(req.headers["cf-connecting-ip"]) : "";
  const ip = fromHeader || req.socket.remoteAddress || "local";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** Địa chỉ gốc của request; Host lạ (có ký tự không hợp lệ) thì null. */
export function originOf(req: IncomingMessage, opts: Pick<BridgeOptions, "trustProxy" | "publicUrl">): string | null {
  if (opts.publicUrl) return new URL(opts.publicUrl).origin;
  const host = req.headers.host ?? "";
  if (!HOST_RE.test(host)) return null;
  const proto = opts.trustProxy && first(req.headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/** Đếm byte khi đọc body không khai độ dài; vượt trần thì cắt. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        seen += chunk.byteLength;
        if (seen > max) c.error(new Error("Body quá lớn"));
        else c.enqueue(chunk);
      },
    }),
  );
}

export function toRequest(req: IncomingMessage, origin: string, opts: BridgeOptions): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.startsWith(":")) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  headers.delete("cf-connecting-ip");
  headers.set("CF-Connecting-IP", clientIpOf(req, opts.trustProxy));
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? capped(Readable.toWeb(req) as ReadableStream<Uint8Array>, opts.maxBodyBytes) : undefined;
  return new Request(origin + (req.url ?? "/"), { method, headers, body, duplex: "half" } as RequestInit);
}

export async function sendResponse(res: ServerResponse, r: Response, head: boolean): Promise<void> {
  const cookies = r.headers.getSetCookie();
  for (const [k, v] of r.headers) if (k !== "set-cookie") res.setHeader(k, v);
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  const len = declaredLength(r.body);
  if (len !== undefined && !r.headers.has("content-length")) res.setHeader("Content-Length", String(len));
  res.writeHead(r.status, r.statusText || undefined);
  if (!r.body || head || r.status === 204 || r.status === 304) {
    await r.body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  const src = Readable.fromWeb(r.body as import("node:stream/web").ReadableStream<Uint8Array>);
  await new Promise<void>((resolve) => {
    src.on("error", () => res.destroy());
    res.on("close", () => {
      src.destroy();
      resolve();
    });
    src.pipe(res);
  });
}

/** ctx cho worker: waitUntil chạy nền, gom lại để lúc tắt server chờ cho xong. */
export function createContext(pending: Set<Promise<unknown>>): ExecutionContext {
  return {
    waitUntil(p: Promise<unknown>) {
      const tracked = Promise.resolve(p)
        .catch((e) => console.error("waitUntil", e))
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function drain(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  try {
    while (!(await reader.read()).done);
  } catch {
    /* client ngắt hoặc vượt trần: không cần đọc nữa */
  }
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export function createNodeHandler(opts: BridgeOptions, pending: Set<Promise<unknown>>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const origin = originOf(req, opts);
      if (!origin) return plain(res, 400, "Bad Host header");
      if (!req.url?.startsWith("/")) return plain(res, 400, "Bad request target");
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > opts.maxBodyBytes) return plain(res, 413, "Payload too large");
      const request = toRequest(req, origin, opts);
      const response = await opts.worker.fetch!(request as Parameters<NonNullable<ExportedHandler<Env>["fetch"]>>[0], opts.env, createContext(pending));
      // Worker trả lời sớm (413, 401…) mà chưa đọc body: đọc bỏ cho hết, không thì client đang gửi bị ECONNRESET
      if (request.body && !request.bodyUsed) await drain(request.body);
      await sendResponse(res, response, request.method === "HEAD");
    } catch (e) {
      console.error("xteinklover node", req.method, req.url, e instanceof Error ? e.stack : e);
      if (!res.headersSent) plain(res, 500, "Internal error");
      else res.destroy();
    }
  };
}
