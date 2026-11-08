// Contestador de Instagram · renovación de tokens de larga duración (caducan a los 60 días).
// Pensado para un cron semanal (ver el ejemplo comentado en la migración).
// Protección: cabecera x-cron-secret = CRON_SECRET (nunca en la URL).
// Renueva las cuentas que llevan más de 30 días sin refrescarse.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ENV_TOKEN = Deno.env.get("IG_ACCESS_TOKEN") ?? "";
const ENV_ACCOUNT = Deno.env.get("IG_ACCOUNT_ID") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_ROLE);

// Comparación en tiempo constante
function igualSeguro(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method", { status: 405 });
  const secreto = req.headers.get("x-cron-secret") ?? "";
  if (!CRON_SECRET || !igualSeguro(secreto, CRON_SECRET)) return new Response("forbidden", { status: 403 });

  const results: any[] = [];

  // Si hay cuenta y token por variable de entorno y aún no están en la base de datos, se añaden.
  if (ENV_ACCOUNT && ENV_TOKEN) {
    const { data: existing } = await db.from("ig_accounts").select("id").eq("ig_user_id", ENV_ACCOUNT).maybeSingle();
    if (!existing) {
      await db.from("ig_accounts").insert({
        ig_user_id: ENV_ACCOUNT, access_token: ENV_TOKEN,
        token_expires_at: new Date(Date.now() + 55 * 24 * 3600 * 1000).toISOString(),
      });
      results.push({ seeded: ENV_ACCOUNT });
    }
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: accounts } = await db.from("ig_accounts").select("*").eq("is_active", true).lt("last_refreshed_at", cutoff);

  for (const acc of accounts ?? []) {
    const etiqueta = acc.username ?? acc.ig_user_id;
    try {
      // La API de refresco de Instagram exige el token en la query; no es el secreto del cron.
      const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(acc.access_token)}`);
      const b = await res.json();
      if (res.ok && b.access_token) {
        await db.from("ig_accounts").update({
          access_token: b.access_token,
          token_expires_at: new Date(Date.now() + (b.expires_in ?? 5184000) * 1000).toISOString(),
          last_refreshed_at: new Date().toISOString(),
        }).eq("id", acc.id);
        results.push({ account: etiqueta, refreshed: true });
      } else {
        results.push({ account: etiqueta, refreshed: false, error: JSON.stringify(b).slice(0, 300) });
      }
    } catch (e) {
      results.push({ account: etiqueta, refreshed: false, error: String(e) });
    }
  }

  return new Response(JSON.stringify({ checked: (accounts ?? []).length, results }, null, 2), {
    headers: { "content-type": "application/json" },
  });
});
