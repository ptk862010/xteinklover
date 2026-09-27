/**
 * Phục vụ thư mục public/ như Cloudflare Workers Assets: "/" → index.html, "/abc" → abc.html nếu có,
 * áp header trong public/_headers (CSP, …), ETag + 304, gzip cho file chữ.
 */
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|xml|wasm)|image\/svg)/;

export interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

/** Đọc định dạng _headers của Cloudflare: dòng đường dẫn (có thể có *), dưới là các dòng "Tên: giá trị" thụt lề. */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const re = line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      rules.push({ pattern: new RegExp(`^${re}$`), headers: [] });
      continue;
    }
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (m && rules.length) rules[rules.length - 1].headers.push([m[1].trim(), m[2]]);
  }
  return rules;
}

/** Đường dẫn URL → file trong root; ra ngoài root, file ẩn hoặc _headers thì null. */
export function resolveAssetPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p.startsWith(".") || p.includes("\\"))) return null;
  if (parts.length === 1 && parts[0] === "_headers") return null;
  const full = normalize(join(root, ...parts));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return full === normalize(root) || full.startsWith(base) ? full : null;
}

async function fileAt(p: string): Promise<{ path: string; size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(p);
    if (s.isFile()) return { path: p, size: s.size, mtimeMs: s.mtimeMs };
    if (s.isDirectory()) return fileAt(join(p, "index.html"));
  } catch {
    /* không có */
  }
  return null;
}

export interface Assets {
  fetch(req: Request): Promise<Response>;
}

export function createAssets(root: string): Assets {
  let rules: HeaderRule[] = [];
  try {
    rules = parseHeadersFile(readFileSync(join(root, "_headers"), "utf8"));
  } catch {
    /* không có _headers */
  }
  const gzCache = new Map<string, { etag: string; body: Uint8Array }>();

  return {
    async fetch(req: Request): Promise<Response> {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(req.url);
      const p = resolveAssetPath(root, url.pathname);
      const file = p ? ((await fileAt(p)) ?? (extname(p) ? null : await fileAt(p + ".html"))) : null;
      if (!file) return new Response(null, { status: 404 });

      const headers = new Headers();
      for (const r of rules) if (r.pattern.test(url.pathname)) for (const [k, v] of r.headers) headers.set(k, v);
      const type = TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream";
      const etag = `W/"${file.size.toString(36)}-${Math.floor(file.mtimeMs).toString(36)}"`;
      headers.set("Content-Type", type);
      headers.set("ETag", etag);
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });

      const gzip = COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers.get("Accept-Encoding") ?? "");
      if (gzip) headers.set("Vary", "Accept-Encoding");
      if (req.method === "HEAD") return new Response(null, { headers });
      let body: Uint8Array = await readFile(file.path);
      if (gzip) {
        const hit = gzCache.get(file.path);
        if (hit?.etag !== etag) gzCache.set(file.path, { etag, body: gzipSync(body) });
        body = gzCache.get(file.path)!.body;
        headers.set("Content-Encoding", "gzip");
      }
      headers.set("Content-Length", String(body.byteLength));
      return new Response(body as Uint8Array<ArrayBuffer>, { headers });
    },
  };
}
