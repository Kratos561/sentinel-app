// sentinel-api — Cloudflare Worker puente solo-lectura hacia InfluxDB.
// SIN secretos en el codigo: INFLUX_* y READ_KEY llegan como Worker Secrets.
const ALLOWED_ORIGIN = "https://kratos561.github.io";

const _rl = new Map();
function rateOk(req) {
    const ip = req.headers.get("CF-Connecting-IP") || "x";
    const now = Date.now();
    const arr = (_rl.get(ip) || []).filter(t => now - t < 60000);
    arr.push(now);
    _rl.set(ip, arr);
    return arr.length <= 90;
}
function safeEq(a, b) {
    a = String(a || ""); b = String(b || "");
    if (a.length !== b.length || a.length === 0) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}
function cors() {
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Max-Age": "86400",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    };
}
function json(obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: cors() });
}
function splitCSV(line) {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
    }
    out.push(cur);
    return out;
}
async function flux(env, q) {
    const res = await fetch(env.INFLUX_URL + "/api/v2/query?org=" + encodeURIComponent(env.INFLUX_ORG), {
        method: "POST",
        headers: { "Authorization": "Token " + env.INFLUX_TOKEN, "Content-Type": "application/vnd.flux", "Accept": "application/csv" },
        body: q
    });
    if (!res.ok) throw new Error("influx " + res.status);
    const text = await res.text();
    const rows = [];
    let cols = null;
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line[0] === "#") continue;
        const cells = splitCSV(line);
        if (!cols) { cols = cells; continue; }
        const o = { tags: {} };
        for (let i = 0; i < cols.length && i < cells.length; i++) {
            const k = cols[i];
            if (k === "_time") o.time = cells[i];
            else if (k === "_value") o.value = cells[i];
            else if (k === "_field") o.field = cells[i];
            else if (k === "symbol" || k === "is_open" || k === "host") o.tags[k] = cells[i];
        }
        rows.push(o);
    }
    return rows;
}
const B = "Sentinel";
const Q = {
    health: 'from(bucket:"' + B + '") |> range(start:-30m) |> filter(fn:(r)=>r._measurement=="bot_health") |> last()',
    positions: 'from(bucket:"' + B + '") |> range(start:-10m) |> filter(fn:(r)=>r._measurement=="open_positions") |> sort(columns:["_time"],desc:true) |> limit(n:24)',
    trades: 'from(bucket:"' + B + '") |> range(start:-7d) |> filter(fn:(r)=>r._measurement=="trades") |> sort(columns:["_time"],desc:true) |> limit(n:15)',
    dl: 'from(bucket:"' + B + '") |> range(start:-2h) |> filter(fn:(r)=>r._measurement=="dl_predict") |> sort(columns:["_time"],desc:true) |> limit(n:40)',
    market: 'from(bucket:"' + B + '") |> range(start:-2h) |> filter(fn:(r)=>r._measurement=="market_data") |> sort(columns:["_time"],desc:true) |> limit(n:40)',
    events: 'from(bucket:"' + B + '") |> range(start:-24h) |> filter(fn:(r)=>r._measurement=="bot_health" and r._field=="event") |> sort(columns:["_time"],desc:true) |> limit(n:10)',
    monitor: 'from(bucket:"' + B + '") |> range(start:-24h) |> filter(fn:(r)=>r._measurement=="v13_3_monitor") |> sort(columns:["_time"],desc:true) |> limit(n:6)'
};
async function buildSnapshot(env) {
    const keys = Object.keys(Q);
    const out = {};
    await Promise.all(keys.map(async k => {
        try { out[k] = await flux(env, Q[k]); }
        catch (e) { out[k] = []; }
    }));
    return out;
}
export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
        if (url.pathname === "/api/snapshot") {
            if (!safeEq(url.searchParams.get("key"), env.READ_KEY)) return json({ ok: false, error: "forbidden" }, 403);
            if (!rateOk(req)) return json({ ok: false, error: "rate" }, 429);
            try {
                const snap = await buildSnapshot(env);
                return json({ ok: true, serverTime: new Date().toISOString(), data: snap });
            } catch (e) { return json({ ok: false, error: "upstream" }, 502); }
        }
        if (url.pathname === "/api/ping") return json({ ok: true, t: new Date().toISOString() });
        return json({ error: "not found" }, 404);
    }
};
