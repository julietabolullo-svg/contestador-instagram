// Contestador de Instagram · desglose de clics por botón de enlace de una regla
// (qué botón pulsó cada persona y, si dejó email, su email).
// Autenticación: cabecera x-admin-password = ADMIN_PASSWORD (comparación en tiempo constante).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const PANEL_ORIGIN = Deno.env.get("PANEL_ORIGIN") ?? "";
const IG_ACCOUNT_ID = Deno.env.get("IG_ACCOUNT_ID") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_ROLE);

// CORS: si PANEL_ORIGIN está definido, solo ese origen; si no, "*" (útil en pruebas locales).
const cors = {
  "Access-Control-Allow-Origin": PANEL_ORIGIN || "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-password",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
}
function igualSeguro(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Cuenta de la instalación (la que está en ig_accounts, o la del entorno)
async function cuentaId(): Promise<string | null> {
  const { data } = await db.from("ig_accounts").select("ig_user_id").eq("is_active", true).order("created_at").limit(1).maybeSingle();
  if (data?.ig_user_id) return String(data.ig_user_id);
  return IG_ACCOUNT_ID || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const pass = req.headers.get("x-admin-password") ?? "";
  if (!ADMIN_PASSWORD || !igualSeguro(pass, ADMIN_PASSWORD)) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const rid = String(body.id ?? "").trim();
  if (!rid) return json({ error: "falta id" }, 400);

  const igId = await cuentaId();
  const { data: rule } = await db.from("ig_rules").select("ig_user_id").eq("id", rid).maybeSingle();
  if (!rule || String(rule.ig_user_id) !== String(igId)) return json({ error: "no encontrada" }, 404);

  const { data: rows } = await db.from("ig_link_clicks").select("igsid, boton, created_at")
    .eq("rule_id", rid).order("created_at", { ascending: false }).limit(5000);
  const ids = [...new Set((rows ?? []).map((r: any) => r.igsid).filter(Boolean))];
  const info: Record<string, { username: string | null; email: string | null }> = {};
  if (ids.length) {
    const { data: cts } = await db.from("ig_contacts").select("igsid, username, email").in("igsid", ids);
    (cts ?? []).forEach((c: any) => { info[c.igsid] = { username: c.username || null, email: c.email || null }; });
  }

  const porBoton: Record<string, any> = {};
  (rows ?? []).forEach((r: any) => {
    const b = r.boton || "(enlace)";
    if (!porBoton[b]) porBoton[b] = { boton: b, total: 0, gente: {} as Record<string, any> };
    porBoton[b].total++;
    const key = r.igsid || ("?" + Math.random());
    const nm = info[r.igsid]?.username || ("@" + String(r.igsid || "").slice(0, 6) + "…");
    if (!porBoton[b].gente[key]) porBoton[b].gente[key] = { username: nm, email: info[r.igsid]?.email || null, veces: 0 };
    porBoton[b].gente[key].veces++;
  });
  const botones = Object.values(porBoton).map((x: any) => {
    const quien = Object.values(x.gente).sort((a: any, b: any) => b.veces - a.veces);
    return { boton: x.boton, total: x.total, personas: quien.length, quien };
  }).sort((a: any, b: any) => b.total - a.total);

  return json({ botones, total: (rows ?? []).length });
});
