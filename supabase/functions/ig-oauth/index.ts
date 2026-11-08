// Contestador de Instagram · callback de OAuth (conectar la cuenta).
// El panel abre https://www.instagram.com/oauth/authorize con redirect_uri = esta función.
// Aquí se canjea el código por un token de larga duración y se guarda la cuenta (una fila).
//
// Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IG_APP_ID, INSTAGRAM_APP_SECRET,
// PANEL_URL (a donde volver), GRAPH_API_VERSION (opcional), RESEND_API_KEY + EMAIL_FROM + ALERT_EMAIL (opcionales, avisos).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IG_APP_ID = Deno.env.get("IG_APP_ID") ?? "";
const IG_APP_SECRET = Deno.env.get("INSTAGRAM_APP_SECRET") ?? "";
const API_VERSION = Deno.env.get("GRAPH_API_VERSION") ?? "v21.0";
const PANEL_URL = Deno.env.get("PANEL_URL") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "";
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "";
const SELF_URL = `${SUPABASE_URL}/functions/v1/ig-oauth`;

const db = createClient(SUPABASE_URL, SERVICE_ROLE);

function redirect(url: string) { return new Response(null, { status: 302, headers: { Location: url } }); }
// Vuelve al panel con un mensaje; si no hay PANEL_URL, muestra el texto tal cual.
function volver(query: string) {
  if (!PANEL_URL) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>Instagram</title><p style="font-family:sans-serif">${query.replace(/[<>&"]/g, "")}</p>`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return redirect(`${PANEL_URL}${PANEL_URL.includes("?") ? "&" : "?"}${query}`);
}
async function logDebug(data: unknown) { try { await db.from("ig_raw").insert({ payload: { oauth_debug: data } }); } catch (_) { /* no bloquea */ } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Los ids de Instagram superan la precisión de los números de JS: se leen como texto.
function sacarId(texto: string): string {
  const m = String(texto).match(/"user_id"\s*:\s*"?(\d+)"?/);
  return m ? m[1] : "";
}

// Aviso por email (sin datos sensibles). Opcional: si faltan variables, solo se registra en consola.
async function avisarFallo(paso: string, detalle: string) {
  if (!RESEND_API_KEY || !EMAIL_FROM || !ALERT_EMAIL) { console.error("ig-oauth fallo:", paso, detalle.slice(0, 200)); return; }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM, to: [ALERT_EMAIL],
        subject: `Una conexión de Instagram ha fallado (${paso})`,
        text: `La conexión de Instagram ha fallado en el paso «${paso}».\n\nDetalle técnico: ${detalle.slice(0, 300)}\n\nEl diagnóstico completo está en la tabla ig_raw.`,
      }),
    });
  } catch (_) { /* el aviso no debe romper nada */ }
}

// Canje del token corto por uno de larga duración (60 días)
async function canjeLargo(shortToken: string): Promise<{ ok: boolean; token?: string; expiresIn?: number; status?: number; body?: string }> {
  const u = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(IG_APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`;
  const r = await fetch(u);
  const t = await r.text();
  let b: any = {}; try { b = JSON.parse(t); } catch { /* texto no JSON */ }
  if (r.ok && b.access_token) return { ok: true, token: b.access_token, expiresIn: b.expires_in ?? 5184000 };
  return { ok: false, status: r.status, body: t.slice(0, 500) };
}

// Meta tarda unos segundos en reconocer un token recién emitido: se reintenta en segundo plano.
async function repararTokenLargo(igUserId: string, shortToken: string) {
  for (const espera of [5000, 10000, 20000, 30000]) {
    await sleep(espera);
    const c = await canjeLargo(shortToken);
    if (c.ok) {
      const expiresAt = new Date(Date.now() + (c.expiresIn ?? 5184000) * 1000).toISOString();
      await db.from("ig_accounts").update({ access_token: c.token, token_expires_at: expiresAt, last_refreshed_at: new Date().toISOString() }).eq("ig_user_id", igUserId);
      await logDebug({ paso: "reparado_en_segundo_plano", ig_user_id: igUserId });
      return;
    }
  }
  await logDebug({ paso: "reparacion_fallida", ig_user_id: igUserId, token_len: shortToken.length });
  await avisarFallo("canje largo tras varios reintentos", `la cuenta ${igUserId} quedó con token provisional de 55 min`);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (!IG_APP_ID || !IG_APP_SECRET) {
    await logDebug({ paso: "config", falta: !IG_APP_ID ? "IG_APP_ID" : "INSTAGRAM_APP_SECRET" });
    return volver("connect_error=" + encodeURIComponent("Falta configurar IG_APP_ID o INSTAGRAM_APP_SECRET"));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    // El usuario ha denegado el permiso (o Meta ha devuelto un error)
    const err = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "missing code";
    await logDebug({ paso: "sin_code", err });
    if (err !== "missing code") await avisarFallo("permiso denegado", err);
    return volver("connect_error=" + encodeURIComponent(err));
  }

  try {
    // 1) Token corto
    const form = new URLSearchParams();
    form.set("client_id", IG_APP_ID);
    form.set("client_secret", IG_APP_SECRET);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", SELF_URL);
    form.set("code", code);
    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
    const shortText = await shortRes.text();
    let shortBody: any = {}; try { shortBody = JSON.parse(shortText); } catch { /* no JSON */ }
    if (!shortBody.access_token && Array.isArray(shortBody.data) && shortBody.data[0]?.access_token) shortBody = shortBody.data[0];
    if (!shortRes.ok || !shortBody.access_token) {
      await logDebug({ paso: "token_corto", status: shortRes.status, body: shortText.slice(0, 500) });
      await avisarFallo("canje inicial", `status ${shortRes.status}`);
      throw new Error("token corto " + shortRes.status);
    }
    const shortToken = String(shortBody.access_token);
    const idDelCanje = sacarId(shortText);

    // 2) Token largo (si Meta aún no lo reconoce, se guarda uno provisional y se repara luego)
    const largo = await canjeLargo(shortToken);
    let token: string;
    let expiresAt: string;
    if (largo.ok) {
      token = largo.token!;
      expiresAt = new Date(Date.now() + (largo.expiresIn ?? 5184000) * 1000).toISOString();
    } else {
      await logDebug({ paso: "token_largo_provisional", status: largo.status, body: largo.body, token_len: shortToken.length });
      token = shortToken;
      expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    }

    // 3) Identidad de la cuenta
    const meRes = await fetch(`https://graph.instagram.com/${API_VERSION}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
    const meText = await meRes.text();
    let me: any = {}; try { me = JSON.parse(meText); } catch { /* no JSON */ }
    const igUserId = sacarId(meText) || idDelCanje;
    if (!igUserId) {
      await logDebug({ paso: "me", status: meRes.status, body: meText.slice(0, 500) });
      await avisarFallo("identificar cuenta", `status ${meRes.status}`);
      throw new Error("sin user_id");
    }

    // 4) Guardar (una sola cuenta: se actualiza la que ya exista)
    const row: any = {
      ig_user_id: igUserId, username: me.username ?? null,
      access_token: token, token_expires_at: expiresAt,
      last_refreshed_at: new Date().toISOString(), is_active: true,
    };
    const { error: upErr } = await db.from("ig_accounts").upsert(row, { onConflict: "ig_user_id" });
    if (upErr) { await logDebug({ paso: "upsert", err: String(upErr.message) }); await avisarFallo("guardar conexión", String(upErr.message)); throw new Error("db"); }

    // 5) Suscribir la app a comentarios y mensajes de esa cuenta
    await fetch(`https://graph.instagram.com/${API_VERSION}/${igUserId}/subscribed_apps?subscribed_fields=comments,messages&access_token=${encodeURIComponent(token)}`, { method: "POST" });

    await logDebug({ paso: largo.ok ? "OK" : "OK_provisional_reparando", username: me.username, ig_user_id: igUserId });

    if (!largo.ok) {
      const tarea = repararTokenLargo(igUserId, shortToken);
      const ER: any = (globalThis as any).EdgeRuntime;
      if (ER?.waitUntil) ER.waitUntil(tarea);
    }

    return volver("connected=" + encodeURIComponent(me.username ?? igUserId));
  } catch (e) {
    return volver("connect_error=" + encodeURIComponent(String(e)));
  }
});
