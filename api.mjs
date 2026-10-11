// Таксопарк — общая база водителей внутри Netlify (Netlify Functions + Netlify Blobs).
// Данные хранятся в самом сайте на Netlify, без Google и других сервисов.
import { getStore } from "@netlify/blobs";

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const FIELDS = ["park", "fio", "link", "clid", "license", "country", "phoneMain", "phoneExtra", "referredBy", "contractType"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

  const drivers = getStore({ name: "drivers", consistency: "strong" });
  const photos = getStore({ name: "driver-photos", consistency: "strong" });

  try {
    // GET /api/ping
    if (parts[0] === "ping") return json({ ok: true });

    // GET /api/drivers — весь список
    if (parts[0] === "drivers" && req.method === "GET" && !parts[1]) {
      const { blobs } = await drivers.list();
      const out = [];
      for (let i = 0; i < blobs.length; i += 50) {
        const chunk = await Promise.all(blobs.slice(i, i + 50).map((b) => drivers.get(b.key, { type: "json" })));
        chunk.forEach((d) => d && out.push(d));
      }
      out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return json({ ok: true, drivers: out });
    }

    // POST /api/drivers — добавить водителя
    if (parts[0] === "drivers" && req.method === "POST" && !parts[1]) {
      const body = await req.json();
      const d = body.driver || {};
      const id = String(d.id || "");
      if (!ID_RE.test(id)) return json({ ok: false, error: "bad_id" }, 400);
      const rec = { id, createdAt: new Date().toISOString() };
      FIELDS.forEach((f) => (rec[f] = String(d[f] ?? "").slice(0, 500)));
      rec.photos = (Array.isArray(d.photos) ? d.photos : [])
        .filter((p) => p && typeof p.key === "string" && p.key.startsWith(id + "/"))
        .slice(0, 30)
        .map((p) => ({ key: p.key, type: String(p.type || "image/jpeg"), name: String(p.name || "").slice(0, 120) }));
      await drivers.setJSON(id, rec);
      return json({ ok: true, driver: rec });
    }

    // DELETE /api/drivers/<id> — удалить водителя и его фото
    if (parts[0] === "drivers" && req.method === "DELETE" && parts[1]) {
      const id = parts[1];
      if (!ID_RE.test(id)) return json({ ok: false, error: "bad_id" }, 400);
      const { blobs } = await photos.list({ prefix: id + "/" });
      await Promise.all(blobs.map((b) => photos.delete(b.key)));
      await drivers.delete(id);
      return json({ ok: true });
    }

    // PUT /api/photos/<driverId>/<n> — загрузить фото (тело запроса — сам файл)
    // GET /api/photos/<driverId>/<n> — получить фото
    if (parts[0] === "photos" && parts[1] && parts[2]) {
      if (!ID_RE.test(parts[1]) || !/^[0-9]{1,3}$/.test(parts[2])) return json({ ok: false, error: "bad_key" }, 400);
      const key = parts[1] + "/" + parts[2];
      if (req.method === "PUT") {
        const type = (req.headers.get("content-type") || "").split(";")[0];
        if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(type)) return json({ ok: false, error: "bad_type" }, 415);
        const bytes = await req.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > MAX_PHOTO_BYTES) return json({ ok: false, error: "too_large" }, 413);
        await photos.set(key, bytes, { metadata: { type } });
        return json({ ok: true, key, type });
      }
      if (req.method === "GET") {
        const entry = await photos.getWithMetadata(key, { type: "arrayBuffer" });
        if (!entry) return json({ ok: false, error: "not_found" }, 404);
        return new Response(entry.data, {
          headers: { "Content-Type": String(entry.metadata?.type || "application/octet-stream"), "Cache-Control": "public, max-age=86400" },
        });
      }
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
};

export const config = { path: "/api/*" };
