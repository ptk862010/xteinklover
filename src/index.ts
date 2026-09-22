import { isAuthorized, unauthorized } from "./auth";
import { BookMeta, OPDS_CONTENT_TYPE, acquisitionFeed, newBookId } from "./opds";

export interface Env {
  BOOKS: KVNamespace;
  ASSETS: Fetcher;
  OPDS_USER: string;
  OPDS_PASSWORD: string;
  CATALOG_TITLE: string;
  MAX_UPLOAD_MB: string;
}

const KEY_PREFIX = "book:";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function baseUrl(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/** KV list trả theo key tăng dần; id tăng theo thời gian nên đảo lại là mới nhất trước. */
async function listBooks(env: Env): Promise<BookMeta[]> {
  const out: BookMeta[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BOOKS.list<BookMeta>({ prefix: KEY_PREFIX, cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

function cleanText(v: FormDataEntryValue | null, fallback: string, max = 200): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return (s || fallback).slice(0, max);
}

async function handleUpload(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Thiếu file" }, 400);
  const maxBytes = Number(env.MAX_UPLOAD_MB || 20) * 1024 * 1024;
  if (file.size > maxBytes) return json({ error: `File quá ${env.MAX_UPLOAD_MB} MB` }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return json({ error: "Chỉ nhận EPUB (chuyển đổi trên trình duyệt trước khi gửi)" }, 415);

  const meta: BookMeta = {
    id: newBookId(),
    title: cleanText(form.get("title"), file.name.replace(/\.epub$/i, "") || "Không tên"),
    author: cleanText(form.get("author"), ""),
    size: bytes.length,
    added: new Date().toISOString(),
  };
  await env.BOOKS.put(KEY_PREFIX + meta.id, bytes, { metadata: meta });
  return json({ ok: true, book: meta });
}

async function handleDownload(id: string, env: Env): Promise<Response> {
  const { value, metadata } = await env.BOOKS.getWithMetadata<BookMeta>(KEY_PREFIX + id, "arrayBuffer");
  if (!value) return new Response("Không có sách này", { status: 404 });
  const name = (metadata?.title ?? id).replace(/[^A-Za-z0-9 ._-]+/g, "_").slice(0, 80) || id;
  return new Response(value, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Length": String(value.byteLength),
      "Content-Disposition": `attachment; filename="${name}.epub"`,
      "Cache-Control": "private, max-age=0",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.OPDS_USER || !env.OPDS_PASSWORD) return new Response("Chưa đặt OPDS_USER / OPDS_PASSWORD (secret của worker)", { status: 500 });
    if (!isAuthorized(req.headers.get("Authorization"), env.OPDS_USER, env.OPDS_PASSWORD)) return unauthorized();

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    if (method === "GET" && (path === "/opds" || path === "/opds/catalog")) {
      const books = await listBooks(env);
      const updated = books[0]?.added ?? new Date().toISOString();
      return new Response(acquisitionFeed({ base: baseUrl(req), title: env.CATALOG_TITLE || "Xteink Lover", books, updated }), {
        headers: { "Content-Type": OPDS_CONTENT_TYPE, "Cache-Control": "no-store" },
      });
    }

    const dl = path.match(/^\/books\/([a-z0-9]+)\.epub$/);
    if (method === "GET" && dl) return handleDownload(dl[1], env);

    if (path === "/api/me" && method === "GET") return json({ user: env.OPDS_USER });

    if (path === "/api/books") {
      if (method === "GET") return json(await listBooks(env));
      if (method === "POST") return handleUpload(req, env);
    }
    const one = path.match(/^\/api\/books\/([a-z0-9]+)$/);
    if (one && method === "DELETE") {
      await env.BOOKS.delete(KEY_PREFIX + one[1]);
      return json({ ok: true });
    }

    if (method === "GET") return env.ASSETS.fetch(req);
    return new Response("Không hỗ trợ", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
