// Contestador de Instagram · registra el clic en un botón de enlace y reenvía al destino.
// Uso: /ig-click?r=<rule_id>&u=<igsid>&b=<boton>&a=<ig_user_id>&d=<url destino URL-encoded>
// SOLO reenvía si el destino es uno de los enlaces de los botones de la regla r (si no, 404).
// Así este dominio no puede usarse para colar enlaces trampa.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Escapa HTML para pintar la URL sin riesgo de inyección
function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Página de respaldo por si el 302 no se sigue: meta refresh y enlace manual (sin scripts).
function pagina(url: string) {
  const safe = esc(url);
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Abriendo…</title><p style="font-family:sans-serif">Abriendo… si no salta solo, <a href="${safe}">pulsa aquí</a>.</p>`;
}
function noValido() {
  return new Response('<!doctype html><meta charset="utf-8"><title>Enlace no válido</title><p style="font-family:sans-serif">Este enlace ya no está disponible.</p>',
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  let dest = p.get("d") || "";
  try { dest = decodeURIComponent(dest); } catch (_e) { /* ya venía sin codificar */ }
  dest = dest.trim();
  const ruleId = (p.get("r") || "").trim();
  if (!/^https?:\/\//i.test(dest) || !UUID_RE.test(ruleId)) return noValido();

  // El destino tiene que ser uno de los botones de enlace de esa regla
  const { data: rule } = await db.from("ig_rules").select("link_button_url,link_button2_url,link_button3_url").eq("id", ruleId).maybeSingle();
  const permitidos = [rule?.link_button_url, rule?.link_button2_url, rule?.link_button3_url].map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!permitidos.includes(dest)) return noValido();

  // No contar el prefetch de bots de Meta o de previsualizaciones
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  const esBot = /facebookexternalhit|facebot|meta-external|bot|crawler|preview|slurp|bingbot/.test(ua);
  if (!esBot) {
    try {
      await db.from("ig_link_clicks").insert({
        rule_id: ruleId, igsid: p.get("u") || null, boton: p.get("b") || null, url: dest, ig_user_id: p.get("a") || null,
      });
    } catch (e) { console.error("log click", e); }
  }
  return new Response(pagina(dest), {
    status: 302,
    headers: { "Location": dest, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
});
