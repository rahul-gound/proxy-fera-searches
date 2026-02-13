let rrIndex = 0;

function pickOrder(pool) {
  const start = rrIndex % pool.length;
  rrIndex = (rrIndex + 1) % pool.length;
  return pool.slice(start).concat(pool.slice(0, start));
}

function normalizeCategories(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input.filter(Boolean).join(",");
  if (typeof input === "string") return input.split(",").map(s => s.trim()).filter(Boolean).join(",");
  return null;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    });
  } finally {
    clearTimeout(t);
  }
}

export default async ({ req, res, log, error }) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  const origin = req.headers?.origin || "*";

  const cors = {
    "Access-Control-Allow-Origin": allowedOrigin === "*" ? "*" : (origin === allowedOrigin ? origin : allowedOrigin),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  if (req.method === "OPTIONS") return res.send("", 204, cors);

  const poolRaw = (process.env.SEARX_POOL || "").trim();
  if (!poolRaw) return res.json({ error: "SEARX_POOL not set" }, 500, cors);

  const pool = poolRaw.split(",").map(s => s.trim()).filter(Boolean);
  if (!pool.length) return res.json({ error: "SEARX_POOL empty" }, 500, cors);

  const body = req.bodyJson || {};
  const query = req.query || {};

  const q = (body.q ?? query.q ?? "").toString().trim();
  const categories = normalizeCategories(body.categories ?? query.categories ?? body.category ?? query.category);

  if (!q || q.length > 200) return res.json({ error: "Invalid q (required, max 200 chars)" }, 400, cors);

  const params = new URLSearchParams({ q, format: "json" });
  if (categories) params.set("categories", categories);

  // Optional pass-through
  const language = (body.language ?? query.language ?? "").toString().trim();
  const page = (body.page ?? query.page ?? "").toString().trim();
  if (language) params.set("language", language);
  if (page) params.set("page", page);

  const order = pickOrder(pool);
  const timeoutMs = 12000;
  const maxAttempts = Math.min(3, order.length);

  let last = null;

  for (let i = 0; i < maxAttempts; i++) {
    const upstream = order[i];
    const url = `${upstream}${upstream.includes("?") ? "&" : "?"}${params.toString()}`;

    try {
      const start = Date.now();
      const r = await fetchWithTimeout(url, timeoutMs);
      const ms = Date.now() - start;

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        last = { upstream, status: r.status, detail: txt.slice(0, 200) };
        log(`upstream_fail status=${r.status} ms=${ms} upstream=${upstream}`);
        continue;
      }

      const data = await r.json();
      data._proxy = { upstream, ms, attempt: i + 1 };

      return res.json(data, 200, { ...cors, "Cache-Control": "no-store" });
    } catch (e) {
      last = { upstream, error: String(e) };
      error(`upstream_error upstream=${upstream} err=${String(e)}`);
      continue;
    }
  }

  return res.json({ error: "All upstream servers failed", last }, 502, { ...cors, "Cache-Control": "no-store" });
};
