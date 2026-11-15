// Kegel v2 — przypomnienia push. Trzyma tylko subskrypcję push + godziny. Zero danych treningowych.
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const ORIGINS = ["https://marzenia42-png.github.io", "http://localhost:8000"];
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
const MSG: Record<string, string> = {
  am: "Poranna sesja · 4 minuty",
  mid: "2 minuty dla siebie · tryb kieszonkowy",
  pm: "Wieczorne rozluźnienie · 4 minuty",
};
const SLOTS = ["am", "mid", "pm"];
const re = /^([01]\d|2[0-3]):[0-5]\d$/;

let cfg: Record<string, string> | null = null;
async function conf() {
  if (!cfg) {
    const r = await sql`select k, v from kegel.config`;
    cfg = Object.fromEntries(r.map((x: any) => [x.k, x.v]));
    webpush.setVapidDetails("mailto:marzenia42@gmail.com", cfg.vapid_pub, cfg.vapid_priv);
  }
  return cfg;
}
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-cron",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}
function okEndpoint(e: unknown) {
  try { const u = new URL(String(e)); return u.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}
function local(tz: string) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: +g("hour") * 60 + +g("minute") };
}
const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
async function send(row: any, body: string) {
  try {
    await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify({ title: "Kegel", body, tag: "kegel" }), { TTL: 3600 });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from kegel.subs where endpoint=${row.endpoint}`;
    return false;
  }
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return new Response("{}", { status: 405, headers: h });
  let b: any = {};
  try { b = await req.json(); } catch { return new Response('{"error":"json"}', { status: 400, headers: h }); }
  const c = await conf();

  if (b.action === "tick") {
    if (req.headers.get("x-cron") !== c.cron_secret) return new Response("{}", { status: 401, headers: h });
    const rows = await sql`select * from kegel.subs`;
    let sent = 0;
    for (const r of rows) {
      const L = local(r.tz || "Europe/Warsaw");
      const ls = r.last_sent || {}, dn = r.done || {};
      for (const s of SLOTS) {
        const t = r[s];
        if (!t || !re.test(t)) continue;
        const d = L.min - toMin(t);
        if (d < 0 || d > 45 || ls[s] === L.date || dn[s] === L.date) continue;
        ls[s] = L.date;
        if (await send(r, MSG[s])) sent++;
      }
      await sql`update kegel.subs set last_sent=${sql.json(ls)} where endpoint=${r.endpoint}`;
    }
    return new Response(JSON.stringify({ ok: true, sent }), { headers: h });
  }

  const sub = b.sub || {};
  const endpoint = sub.endpoint || b.endpoint;
  if (!okEndpoint(endpoint)) return new Response('{"error":"endpoint"}', { status: 400, headers: h });

  if (b.action === "save") {
    const k = sub.keys || {};
    if (!k.p256dh || !k.auth) return new Response('{"error":"keys"}', { status: 400, headers: h });
    const t = b.times || {};
    const v = (x: unknown) => (typeof x === "string" && re.test(x) ? x : null);
    const tz = typeof b.tz === "string" && b.tz.length < 60 ? b.tz : "Europe/Warsaw";
    await sql`insert into kegel.subs(endpoint,p256dh,auth,am,mid,pm,tz,updated_at)
      values(${endpoint},${k.p256dh},${k.auth},${v(t.am)},${v(t.mid)},${v(t.pm)},${tz},now())
      on conflict(endpoint) do update set p256dh=excluded.p256dh,auth=excluded.auth,am=excluded.am,mid=excluded.mid,pm=excluded.pm,tz=excluded.tz,updated_at=now()`;
    return new Response('{"ok":true}', { headers: h });
  }
  if (b.action === "delete") {
    await sql`delete from kegel.subs where endpoint=${endpoint}`;
    return new Response('{"ok":true}', { headers: h });
  }
  if (b.action === "done") {
    const s = SLOTS.includes(b.slot) ? b.slot : null;
    if (!s) return new Response('{"error":"slot"}', { status: 400, headers: h });
    const r = (await sql`select tz from kegel.subs where endpoint=${endpoint}`)[0];
    if (!r) return new Response('{"ok":false}', { headers: h });
    const L = local(r.tz);
    await sql`update kegel.subs set done = done || ${sql.json({ [s]: L.date })} where endpoint=${endpoint}`;
    return new Response('{"ok":true}', { headers: h });
  }
  if (b.action === "test") {
    const r = (await sql`select * from kegel.subs where endpoint=${endpoint}`)[0];
    if (!r) return new Response('{"ok":false}', { headers: h });
    const ok = await send(r, "Test przypomnienia — działa.");
    return new Response(JSON.stringify({ ok }), { headers: h });
  }
  return new Response('{"error":"action"}', { status: 400, headers: h });
});
