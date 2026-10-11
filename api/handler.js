// Таксопарк — общая база водителей на Vercel (Vercel Functions + Vercel Blob).
// Водители хранятся как JSON-файлы drivers/<id>.json, фото — photos/<id>/...
import { put, list, del } from "@vercel/blob";

const ACCESS = process.env.BLOB_ACCESS || "public";
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const FIELDS = ["park", "fio", "link", "clid", "license", "country", "phoneMain", "phoneExtra", "referredBy", "contractType"];
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

async function listAll(prefix) {
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const send = (status, data) => res.status(status).json(data);
  const parts = String(req.query.path || "").split("/").filter(Boolean);

  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    return send(500, { ok: false, error: "storage_not_connected" });
  }

  try {
    if (parts[0] === "ping") return send(200, { ok: true });

    // GET drivers — весь список
    if (parts[0] === "drivers" && req.method === "GET" && !parts[1]) {
      const blobs = await listAll("drivers/");
      const out = [];
      for (let i = 0; i < blobs.length; i += 25) {
        const chunk = await Promise.all(
          blobs.slice(i, i + 25).map((b) =>
            fetch(b.url + "?v=" + encodeURIComponent(b.etag || ""), {
              headers: ACCESS === "private" ? { Authorization: "Bearer " + process.env.BLOB_READ_WRITE_TOKEN } : {},
            }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
          )
        );
        chunk.forEach((d) => d && out.push(d));
      }
      out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return send(200, { ok: true, drivers: out });
    }

    // POST drivers — добавить водителя
    if (parts[0] === "drivers" && req.method === "POST" && !parts[1]) {
      const body = await readBody(req);
      const d = body.driver || {};
      const id = String(d.id || "");
      if (!ID_RE.test(id)) return send(400, { ok: false, error: "bad_id" });
      const rec = { id, createdAt: new Date().toISOString() };
      FIELDS.forEach((f) => (rec[f] = String(d[f] ?? "").slice(0, 500)));
      rec.photos = (Array.isArray(d.photos) ? d.photos : [])
        .filter((p) => p && typeof p.key === "string" && p.key.startsWith("photos/" + id + "/") && /^https:\/\//.test(p.url || ""))
        .slice(0, 30)
        .map((p) => ({ key: p.key, url: p.url, type: String(p.type || "image/jpeg"), name: String(p.name || "").slice(0, 120) }));
      await put(`drivers/${id}.json`, JSON.stringify(rec), {
        access: ACCESS, addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60,
      });
      return send(200, { ok: true, driver: rec });
    }

    // DELETE drivers/<id> — удалить водителя и его фото
    if (parts[0] === "drivers" && req.method === "DELETE" && parts[1]) {
      const id = parts[1];
      if (!ID_RE.test(id)) return send(400, { ok: false, error: "bad_id" });
      const items = [...(await listAll(`photos/${id}/`)), ...(await listAll(`drivers/${id}.json`))];
      if (items.length) await del(items.map((b) => b.url));
      return send(200, { ok: true });
    }

    // POST photos — загрузить фото {driverId, n, type, data(base64)}
    if (parts[0] === "photos" && req.method === "POST") {
      const body = await readBody(req);
      const id = String(body.driverId || "");
      const n = String(body.n ?? "");
      const type = String(body.type || "");
      if (!ID_RE.test(id) || !/^[0-9]{1,3}$/.test(n)) return send(400, { ok: false, error: "bad_key" });
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return send(415, { ok: false, error: "bad_type" });
      const bytes = Buffer.from(String(body.data || ""), "base64");
      if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) return send(413, { ok: false, error: "too_large" });
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      const r = await put(`photos/${id}/${n}.${ext}`, bytes, { access: ACCESS, addRandomSuffix: true, contentType: type });
      return send(200, { ok: true, key: r.pathname, url: r.url, type });
    }

    return send(404, { ok: false, error: "not_found" });
  } catch (err) {
    return send(500, { ok: false, error: String((err && err.message) || err) });
  }
}
