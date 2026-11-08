// Contestador de Instagram · API del panel de administración (una cuenta).
// Autenticación: cabecera x-admin-password = ADMIN_PASSWORD (comparación en tiempo constante).
// Todas las acciones van por POST con { action: "...", ...datos }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const PANEL_ORIGIN = Deno.env.get("PANEL_ORIGIN") ?? "";
const ACCESS_TOKEN = Deno.env.get("IG_ACCESS_TOKEN") ?? "";
const IG_ACCOUNT_ID = Deno.env.get("IG_ACCOUNT_ID") ?? "";
const API_VERSION = Deno.env.get("GRAPH_API_VERSION") ?? "v21.0";
const GRAPH_BASE = Deno.env.get("GRAPH_BASE") ?? "https://graph.instagram.com";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const db = createClient(SUPABASE_URL, SERVICE_ROLE);

// CORS: si PANEL_ORIGIN está definido, solo ese origen; si no, "*" (útil en pruebas locales).
const cors = {
  "Access-Control-Allow-Origin": PANEL_ORIGIN || "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-password",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}
// Comparación en tiempo constante de dos cadenas
function igualSeguro(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
function tally(rows: any[], key: string) {
  const c: Record<string, number> = {};
  (rows ?? []).forEach((r: any) => { const k = r[key]; if (k) c[k] = (c[k] || 0) + 1; });
  return c;
}
function normalizarUrl(u: unknown): string | null {
  const s = String(u ?? "").trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, "");
}
// Repara saltos de línea reales dentro de las cadenas de un JSON devuelto por la IA
function repararJson(s: string): string {
  let out = "", dentro = false, esc = false;
  for (const ch of s) {
    if (dentro) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { dentro = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') dentro = true;
      out += ch;
    }
  }
  return out;
}

// Cuenta única: la de la base de datos (OAuth) o la del entorno (fallback).
async function cuentaId(): Promise<string | null> {
  const { data } = await db.from("ig_accounts").select("ig_user_id").eq("is_active", true).order("created_at").limit(1).maybeSingle();
  if (data?.ig_user_id) return String(data.ig_user_id);
  return IG_ACCOUNT_ID || null;
}
async function tokenDe(igId: string | null): Promise<string> {
  if (!igId) return "";
  const { data } = await db.from("ig_accounts").select("access_token").eq("ig_user_id", igId).maybeSingle();
  return data?.access_token || (igId === IG_ACCOUNT_ID ? ACCESS_TOKEN : "");
}
async function mlKeyDe(igId: string | null): Promise<string> {
  if (!igId) return "";
  const { data } = await db.from("ig_accounts").select("mailerlite_api_key").eq("ig_user_id", igId).maybeSingle();
  return data?.mailerlite_api_key || "";
}

// Sincroniza el menú de preguntas frecuentes del chat de Instagram (máx. 4).
async function syncMenuFaqs(igId: string | null) {
  if (!igId) return { ok: false, skipped: "sin_cuenta" };
  const token = await tokenDe(igId);
  if (!token) return { ok: false, skipped: "no_token" };
  const { data: faqs } = await db.from("ig_faqs").select("id,pregunta").eq("ig_user_id", igId)
    .eq("is_active", true).eq("en_menu", true).order("created_at").limit(4);
  try {
    let res: Response;
    const url = `${GRAPH_BASE}/${API_VERSION}/me/messenger_profile`;
    const headers = { "content-type": "application/json", Authorization: `Bearer ${token}` };
    if (faqs && faqs.length) {
      const body = { platform: "instagram", ice_breakers: [{
        call_to_actions: faqs.map((f: any) => ({ question: String(f.pregunta).slice(0, 80), payload: `faq:${f.id}` })),
        locale: "default",
      }] };
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } else {
      res = await fetch(url, { method: "DELETE", headers, body: JSON.stringify({ platform: "instagram", fields: ["ice_breakers"] }) });
    }
    const t = await res.text();
    return { ok: res.ok, status: res.status, detalle: t.slice(0, 300), n: faqs?.length ?? 0 };
  } catch (e) { return { ok: false, detalle: String(e) }; }
}

// «También en historias»: mantiene una regla gemela con media_id STORIES.
async function sincronizarGemela(main: any, r: any) {
  if (!main?.id) return;
  const mid = main.media_id;
  const gemelable = mid && mid !== "STORIES" && !String(mid).startsWith("STORY:");
  const { data: twin } = await db.from("ig_rules").select("id").eq("twin_de", main.id).maybeSingle();
  if (r.en_historias && gemelable) {
    const row: any = {
      ig_user_id: main.ig_user_id, keyword: main.keyword, match_type: main.match_type,
      reply_text: main.reply_text, reply_variants: main.reply_variants, public_replies: main.public_replies,
      image_url: main.image_url, audio_url: main.audio_url, click_image_url: main.click_image_url,
      button_text: main.button_text, ask_email: main.ask_email, require_follow: main.require_follow,
      follow_prompt: main.follow_prompt, email_prompt: main.email_prompt, final_message: main.final_message,
      link_button_text: main.link_button_text, link_button_url: main.link_button_url,
      link_button2_text: main.link_button2_text, link_button2_url: main.link_button2_url,
      link_button3_text: main.link_button3_text, link_button3_url: main.link_button3_url,
      etiqueta: main.etiqueta, mailerlite_group_id: main.mailerlite_group_id,
      media_id: "STORIES", is_active: main.is_active, twin_de: main.id, en_historias: false,
    };
    if (twin) await db.from("ig_rules").update(row).eq("id", twin.id);
    else await db.from("ig_rules").insert(row);
  } else if (twin) {
    await db.from("ig_rules").delete().eq("id", twin.id);
  }
}

// Llamada a Anthropic para sugerir textos (solo si ANTHROPIC_API_KEY está definida).
const SYSTEM_IA = [
  "Eres copywriter de Instagram y escribes en español de España, de tú, como habla la gente. Frases cortas.",
  "",
  "ESTO ES UN AUTORESPONDEDOR, NO CONTENIDO. Las respuestas públicas y los DMs son mensajes CORTOS y naturales, como cuando alguien contesta rápido desde el móvil. Nada de marcos de contenido, titulares ni jerga interna. Una respuesta pública buena es simple y avisa de que se lo mandas por privado. Ejemplos válidos: «¡Te lo mando por DM! 📩», «Míralo en tus mensajes 👀», «Ya te he escrito por privado 💌».",
  "",
  "REGLA DE ORO: la especificidad vende. Cada mensaje nombra el regalo concreto y lo que la persona se lleva con él. Si un mensaje valdría igual para un regalo distinto, está mal escrito.",
  "",
  "NO TE INVENTES NADA. Solo puedes afirmar lo que esté en el brief o en el documento adjunto. Nada de número de páginas, plantillas, bonus, precios, plazos ni resultados que no te hayan dado.",
  "",
  "PROHIBIDO:",
  "- Enlaces: NINGUNA URL y NUNCA el marcador TU_ENLACE en respuestas_publicas, mensajes_dm, texto_boton ni mensaje_email. El único sitio donde va un enlace es mensaje_entrega, y siempre como TU_ENLACE literal.",
  "- Comodines: «esto», «este recurso», «lo que te prometí», «el contenido», «la info», «material exclusivo».",
  "- Lenguaje de gurú: «sin más dilación», «te va a volar la cabeza», «game changer», «transformar», «revolucionar», «llevar al siguiente nivel», «secreto mejor guardado».",
  "- Saludos de relleno: «hola guapa», «espero que estés genial», «¿qué tal?».",
  "- Mayúsculas para gritar, signos dobles (!!, ??) y puntos suspensivos de relleno.",
  "",
  "EMOJIS: como mucho uno por mensaje, y solo si aporta algo. Nunca dos seguidos.",
  "",
  "Devuelves únicamente JSON válido en UNA sola línea: dentro de las cadenas usa \\n para los saltos de línea, nunca un salto real. Sin markdown, sin explicaciones, sin nada alrededor.",
].join("\n");

async function aiCopy(body: any) {
  const brief = String(body.brief ?? "").slice(0, 1500).trim();
  const keyword = String(body.keyword ?? "").slice(0, 60).trim();
  const pdf = String(body.pdf ?? "").trim();
  if (!brief && !pdf) return json({ error: "Cuéntame un poco de qué va, o adjunta tu lead magnet" }, 400);
  if (pdf && pdf.length > 28_000_000) return json({ error: "El PDF no puede pasar de 20 MB" }, 400);
  if (pdf && !/^[A-Za-z0-9+/=\s]+$/.test(pdf.slice(0, 200))) return json({ error: "Ese PDF no se ha podido leer, prueba a adjuntarlo otra vez" }, 400);
  if (!ANTHROPIC_KEY) return json({ error: "IA no configurada (falta ANTHROPIC_API_KEY)" }, 500);

  const notaPdf = pdf ? [
    "",
    "Te adjunto el DOCUMENTO REAL del regalo. Léelo entero y saca de ahí:",
    "- el título exacto, tal y como está escrito",
    "- la promesa principal",
    "- tres cosas concretas de dentro: un dato, un paso, un ejemplo.",
    "",
    "Lo que diga el documento manda sobre el brief. No reutilices el texto de la portada ni el de la última página: coge lo de dentro.",
  ].join("\n") : "";

  const user = [
    `Estoy montando un autorespondedor de Instagram: cuando alguien comenta "${keyword || "(palabra clave)"}" en mi post, le contesto en público y le mando un DM para entregarle un regalo.`,
    "",
    "QUÉ REGALO Y CONTEXTO:",
    brief || "(sin brief: sácalo todo del documento adjunto)",
    notaPdf,
    "",
    "Devuelve SOLO este JSON, con textos reales dentro:",
    "{",
    ' "respuestas_publicas": ["cuatro respuestas públicas al comentario, MÁXIMO 60 caracteres cada una, avisando de que mire los DMs. Al menos dos SIN emoji. Sin enlaces."],',
    ' "mensajes_dm": ["tres aperturas de DM, MÁXIMO 300 caracteres cada una, con ángulos distintos. Cada una nombra el regalo y termina invitando a pulsar el botón de abajo. SIN enlaces ni TU_ENLACE."],',
    ' "texto_boton": "máximo 20 caracteres, en primera persona y concreto",',
    ' "mensaje_email": "máximo 200 caracteres. Pide el email antes de entregar y recuerda qué va a recibir",',
    ' "mensaje_entrega": "máximo 250 caracteres. Lleva TU_ENLACE literal donde irá el enlace, y una frase diciendo por dónde empezar"',
    "}",
  ].join("\n");

  const contenido: any = pdf
    ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.replace(/\s+/g, "") } }, { type: "text", text: user }]
    : user;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: pdf ? 4000 : 2000,
      thinking: { type: "disabled" },
      system: SYSTEM_IA,
      messages: [{ role: "user", content: contenido }],
    }),
  });
  const d = await r.json();
  if (!r.ok) return json({ error: "IA: " + (d?.error?.message || ("error " + r.status)) }, 500);
  const bloque = Array.isArray(d?.content) ? d.content.find((c: any) => c?.type === "text") : null;
  const txt: string = bloque?.text ?? "";
  const i = txt.indexOf("{"), j = txt.lastIndexOf("}");
  if (i < 0 || j < 0) return json({ error: "La IA no devolvió un formato válido, prueba otra vez" }, 500);
  const crudo = txt.slice(i, j + 1);
  let parsed;
  try { parsed = JSON.parse(crudo); }
  catch {
    try { parsed = JSON.parse(repararJson(crudo)); }
    catch { console.error("ai_copy JSON irreparable:", crudo.slice(0, 400)); return json({ error: "La IA no devolvió un formato válido, prueba otra vez" }, 500); }
  }
  return json({ sugerencias: parsed });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // Autenticación: contraseña de administración (sin ella, nada)
  const pass = req.headers.get("x-admin-password") ?? "";
  if (!ADMIN_PASSWORD || !igualSeguro(pass, ADMIN_PASSWORD)) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body.action as string;

  try {
    const igId = await cuentaId();
    const sinCuenta = () => json({ error: "Conecta primero tu Instagram (botón «Conectar Instagram»)" }, 400);

    if (action === "whoami") {
      const { data: accs } = igId
        ? await db.from("ig_accounts").select("ig_user_id, username, is_active, token_expires_at").eq("ig_user_id", igId)
        : { data: [] };
      return json({ cuentas: accs ?? [] });
    }

    if (action === "upload_media") {
      const kind = body.kind === "audio" ? "audio" : "image";
      const nombre = String(body.filename ?? "archivo").replace(/[^a-z0-9._-]/gi, "_").slice(0, 80);
      const b64 = String(body.data ?? "");
      if (!b64) return json({ error: "Falta el archivo" }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { return json({ error: "Archivo inválido" }, 400); }
      const MAX = kind === "audio" ? 15 * 1024 * 1024 : 8 * 1024 * 1024;
      if (bytes.length > MAX) return json({ error: kind === "audio" ? "El audio no puede pasar de 15 MB" : "La imagen no puede pasar de 8 MB" }, 400);
      const tipos: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg" };
      const ext = (nombre.split(".").pop() ?? "").toLowerCase();
      const contentType = tipos[ext] ?? (kind === "audio" ? "audio/mpeg" : "image/jpeg");
      if (kind === "image" && !contentType.startsWith("image/")) return json({ error: "Ese archivo no parece una imagen (jpg, png, gif, webp)" }, 400);
      if (kind === "audio" && !contentType.startsWith("audio/")) return json({ error: "Ese archivo no parece un audio (mp3, m4a, aac, wav)" }, 400);
      const path = `${kind}/${Date.now()}_${nombre}`;
      const { error } = await db.storage.from("ig-autodm").upload(path, bytes, { contentType, upsert: false });
      if (error) return json({ error: "Storage: " + error.message }, 500);
      const url = db.storage.from("ig-autodm").getPublicUrl(path).data.publicUrl;
      return json({ url });
    }

    if (action === "ai_copy") return await aiCopy(body);

    if (action === "list_accounts") {
      const { data, error } = await db.from("ig_accounts")
        .select("ig_user_id, username, is_active, token_expires_at, last_refreshed_at, mailerlite_api_key")
        .order("created_at");
      if (error) throw error;
      const accounts = (data ?? []).map((a: any) => ({
        ig_user_id: a.ig_user_id, username: a.username, is_active: a.is_active,
        token_expires_at: a.token_expires_at, last_refreshed_at: a.last_refreshed_at,
        has_mailerlite: !!a.mailerlite_api_key,
      }));
      return json({ accounts });
    }

    if (action === "set_mailerlite_key") {
      const key = String(body.key ?? "").trim();
      if (!key) return json({ error: "Falta la API key" }, 400);
      if (!igId) return sinCuenta();
      const test = await fetch("https://connect.mailerlite.com/api/groups?limit=1", { headers: { Accept: "application/json", Authorization: `Bearer ${key}` } });
      if (test.status === 401) return json({ error: "API key inválida — revísala en MailerLite → Integrations" }, 400);
      const { error } = await db.from("ig_accounts").update({ mailerlite_api_key: key }).eq("ig_user_id", igId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "mailerlite_groups") {
      const key = await mlKeyDe(igId);
      if (!key) return json({ groups: [], note: "no_key" });
      const res = await fetch("https://connect.mailerlite.com/api/groups", { headers: { Accept: "application/json", Authorization: `Bearer ${key}` } });
      const b = await res.json().catch(() => ({}));
      return json({ groups: Array.isArray(b?.data) ? b.data.map((g: any) => ({ id: g.id, name: g.name })) : [] });
    }

    if (action === "list_rules") {
      if (!igId) return json({ rules: [] });
      const { data: rules, error } = await db.from("ig_rules").select("*").eq("ig_user_id", igId).is("twin_de", null).order("created_at", { ascending: false });
      if (error) throw error;
      await Promise.all((rules ?? []).map(async (r: any) => {
        const [s, c, e] = await Promise.all([
          db.from("ig_events").select("*", { count: "exact", head: true }).in("dm_status", ["sent", "resent"]).eq("matched_rule_id", r.id),
          db.from("ig_clicks").select("*", { count: "exact", head: true }).eq("rule_id", r.id),
          db.from("ig_conversations").select("*", { count: "exact", head: true }).eq("rule_id", r.id).eq("state", "done").not("email", "is", null),
        ]);
        r.sent_count = s.count || 0; r.click_count = c.count || 0; r.email_count = e.count || 0;
        r.ctr = r.sent_count ? Math.round(r.click_count / r.sent_count * 100) : 0;
      }));
      return json({ rules: rules ?? [] });
    }

    if (action === "rule_stats") {
      const rid = body.id;
      if (!rid) return json({ error: "falta id" }, 400);
      const { data: rule } = await db.from("ig_rules").select("*").eq("id", rid).maybeSingle();
      if (!rule || String(rule.ig_user_id) !== String(igId)) return json({ error: "no encontrada" }, 404);
      const { data: eventos } = await db.from("ig_events")
        .select("created_at, commenter_username, comment_text, dm_status, public_reply_status, origen")
        .eq("matched_rule_id", rid).order("created_at", { ascending: false }).limit(200);
      const { data: convs } = await db.from("ig_conversations")
        .select("igsid, email, updated_at").eq("rule_id", rid).eq("state", "done")
        .order("updated_at", { ascending: false }).limit(200);
      const ids = (convs ?? []).map((c: any) => c.igsid).filter(Boolean);
      const names: Record<string, string> = {};
      if (ids.length) {
        const { data: cts } = await db.from("ig_contacts").select("igsid, username").in("igsid", ids);
        (cts ?? []).forEach((c: any) => { if (c.username) names[c.igsid] = c.username; });
      }
      const emails = (convs ?? []).map((c: any) => ({ email: c.email, username: names[c.igsid] || null, fecha: c.updated_at }));
      const [tot, dms, pubs, entregas, emailsN, clicksC, clickRows] = await Promise.all([
        db.from("ig_events").select("*", { count: "exact", head: true }).eq("matched_rule_id", rid),
        db.from("ig_events").select("*", { count: "exact", head: true }).eq("matched_rule_id", rid).in("dm_status", ["sent", "resent"]),
        db.from("ig_events").select("*", { count: "exact", head: true }).eq("matched_rule_id", rid).eq("public_reply_status", "sent"),
        db.from("ig_entregas").select("*", { count: "exact", head: true }).eq("rule_id", rid),
        db.from("ig_conversations").select("*", { count: "exact", head: true }).eq("rule_id", rid).eq("state", "done").not("email", "is", null),
        db.from("ig_clicks").select("*", { count: "exact", head: true }).eq("rule_id", rid),
        db.from("ig_clicks").select("igsid").eq("rule_id", rid).limit(5000),
      ]);
      const unicos = new Set((clickRows.data ?? []).map((c: any) => c.igsid)).size;
      const funnel = { comentarios: tot.count || 0, dms: dms.count || 0, publicas: pubs.count || 0, clicks: clicksC.count || 0, clicks_unicos: unicos, emails: emailsN.count || 0, entregas: entregas.count || 0 };
      const { access_token: _t, ...reglaSinToken } = rule as any;
      return json({ keyword: rule.keyword ?? "", regla: reglaSinToken, funnel, eventos: eventos ?? [], clicks: clicksC.count || 0, emails });
    }

    if (action === "upsert_rule") {
      const r = body.rule ?? {};
      if (!igId) return sinCuenta();
      const variants: string[] = Array.isArray(r.reply_variants) ? r.reply_variants.map((s: string) => (s ?? "").trim()).filter(Boolean) : [];
      const pubs: string[] = Array.isArray(r.public_replies) ? r.public_replies.map((s: string) => (s ?? "").trim()).filter(Boolean) : [];
      if (!r.keyword || !r.keyword.trim()) return json({ error: "Falta la palabra clave" }, 400);
      if (variants.length === 0) return json({ error: "Añade al menos un mensaje" }, 400);
      if (r.id) {
        const { data: ex } = await db.from("ig_rules").select("ig_user_id").eq("id", r.id).maybeSingle();
        if (!ex || String(ex.ig_user_id) !== String(igId)) return json({ error: "no encontrada" }, 404);
      }
      const mediaId = r.media_id?.trim() || null;
      if (!r.id) {
        let q = db.from("ig_rules").select("id").eq("ig_user_id", igId).eq("keyword", r.keyword.trim());
        q = mediaId ? q.eq("media_id", mediaId) : q.is("media_id", null);
        const { data: dup } = await q.limit(1).maybeSingle();
        if (dup) return json({ error: "Ya tienes una automatización con esa misma palabra clave" + (mediaId ? " en ese destino" : "") + ". Edítala desde la lista en vez de crear otra igual." }, 409);
      }
      const row: any = {
        keyword: r.keyword.trim(), match_type: r.match_type === "exact" ? "exact" : "contains",
        reply_text: variants[0], reply_variants: variants,
        public_replies: pubs.length ? pubs : null,
        image_url: r.image_url?.trim() || null, audio_url: r.audio_url?.trim() || null, media_id: mediaId,
        click_image_url: r.click_image_url?.trim() || null,
        link_button_text: r.link_button_text?.trim() || null, link_button_url: normalizarUrl(r.link_button_url),
        link_button2_text: r.link_button2_text?.trim() || null, link_button2_url: normalizarUrl(r.link_button2_url),
        link_button3_text: r.link_button3_text?.trim() || null, link_button3_url: normalizarUrl(r.link_button3_url),
        button_text: r.button_text?.trim() || null, ask_email: !!r.ask_email,
        require_follow: !!r.require_follow, follow_prompt: r.follow_prompt?.trim() || null,
        email_prompt: r.email_prompt?.trim() || null, final_message: r.final_message?.trim() || null,
        etiqueta: String(r.etiqueta ?? "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40) || null,
        mailerlite_group_id: r.mailerlite_group_id?.trim() || null,
        next_after: mediaId === "NEXT" ? new Date().toISOString() : null,
        is_active: r.is_active !== false,
        en_historias: !!r.en_historias,
      };
      if (!r.id) row.ig_user_id = igId;
      const q = r.id
        ? db.from("ig_rules").update(row).eq("id", r.id).select().single()
        : db.from("ig_rules").insert(row).select().single();
      const { data, error } = await q;
      if (error) throw error;
      await sincronizarGemela(data, r);
      return json({ rule: data });
    }

    if (action === "toggle_rule") {
      const { data, error } = await db.from("ig_rules").update({ is_active: !!body.is_active }).eq("id", body.id).eq("ig_user_id", igId ?? "-").select().maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "no encontrada" }, 404);
      await db.from("ig_rules").update({ is_active: !!body.is_active }).eq("twin_de", data.id);
      return json({ rule: data });
    }

    if (action === "delete_rule") {
      const { data, error } = await db.from("ig_rules").delete().eq("id", body.id).eq("ig_user_id", igId ?? "-").select("id").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "no encontrada" }, 404);
      await db.from("ig_rules").delete().eq("twin_de", data.id);
      return json({ ok: true });
    }

    if (action === "list_faqs") {
      if (!igId) return json({ faqs: [] });
      const { data: faqs, error } = await db.from("ig_faqs").select("*").eq("ig_user_id", igId).order("created_at");
      if (error) throw error;
      const ids = (faqs ?? []).map((f: any) => f.id);
      const { data: hits } = ids.length ? await db.from("ig_faq_hits").select("faq_id").in("faq_id", ids).limit(5000) : { data: [] };
      const ch = tally(hits ?? [], "faq_id");
      (faqs ?? []).forEach((f: any) => { f.hits = ch[f.id] || 0; });
      return json({ faqs });
    }

    if (action === "upsert_faq") {
      const f = body.faq ?? {};
      if (!igId) return sinCuenta();
      if (!f.pregunta?.trim()) return json({ error: "Ponle la pregunta" }, 400);
      if (!f.keywords?.trim()) return json({ error: "Añade las palabras clave que la disparan" }, 400);
      if (!f.respuesta?.trim()) return json({ error: "Escribe la respuesta" }, 400);
      if (f.id) {
        const { data: ex } = await db.from("ig_faqs").select("ig_user_id").eq("id", f.id).maybeSingle();
        if (!ex || String(ex.ig_user_id) !== String(igId)) return json({ error: "no encontrada" }, 404);
      }
      if (f.en_menu) {
        const { count } = await db.from("ig_faqs").select("*", { count: "exact", head: true })
          .eq("ig_user_id", igId).eq("en_menu", true).eq("is_active", true)
          .neq("id", f.id || "00000000-0000-0000-0000-000000000000");
        if ((count ?? 0) >= 4) return json({ error: "El menú del chat admite 4 preguntas como máximo — quita otra primero" }, 400);
      }
      const row: any = {
        pregunta: f.pregunta.trim().slice(0, 80), keywords: f.keywords.trim(), respuesta: f.respuesta.trim(),
        image_url: f.image_url?.trim() || null,
        link_button_text: f.link_button_text?.trim() || null, link_button_url: normalizarUrl(f.link_button_url),
        en_menu: !!f.en_menu, is_active: f.is_active !== false,
      };
      if (!f.id) row.ig_user_id = igId;
      const q = f.id
        ? db.from("ig_faqs").update(row).eq("id", f.id).select().single()
        : db.from("ig_faqs").insert(row).select().single();
      const { data, error } = await q;
      if (error) throw error;
      const menu = await syncMenuFaqs(igId);
      return json({ faq: data, menu });
    }

    if (action === "toggle_faq") {
      const { data, error } = await db.from("ig_faqs").update({ is_active: !!body.is_active }).eq("id", body.id).eq("ig_user_id", igId ?? "-").select().maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "no encontrada" }, 404);
      const menu = await syncMenuFaqs(igId);
      return json({ faq: data, menu });
    }

    if (action === "delete_faq") {
      const { data, error } = await db.from("ig_faqs").delete().eq("id", body.id).eq("ig_user_id", igId ?? "-").select("ig_user_id").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "no encontrada" }, 404);
      const menu = await syncMenuFaqs(igId);
      return json({ ok: true, menu });
    }

    if (action === "faq_menu_sync") return json({ menu: await syncMenuFaqs(igId) });

    if (action === "list_events") {
      if (!igId) return json({ events: [] });
      const { data, error } = await db.from("ig_events")
        .select("created_at, comment_text, commenter_username, dm_status, dm_error, media_id, public_reply_status, origen, ig_user_id, rule:ig_rules!ig_events_matched_rule_id_fkey(keyword)")
        .eq("ig_user_id", igId).order("created_at", { ascending: false }).limit(80);
      if (error) throw error;
      return json({ events: (data ?? []).map((e: any) => ({ ...e, automation: e.rule?.keyword ?? null, rule: undefined })) });
    }

    if (action === "list_contacts") {
      if (!igId) return json({ contacts: [] });
      const { data, error } = await db.from("ig_contacts").select("username, email, interactions, last_seen")
        .eq("ig_user_id", igId).order("last_seen", { ascending: false }).limit(500);
      if (error) throw error;
      return json({ contacts: data });
    }

    if (action === "metrics") {
      if (!igId) return json({ metrics: { sent: 0, contacts: 0, emails: 0, sent7: 0 } });
      const { count: sent } = await db.from("ig_events").select("*", { count: "exact", head: true }).in("dm_status", ["sent", "resent"]).eq("ig_user_id", igId);
      const { count: contacts } = await db.from("ig_contacts").select("*", { count: "exact", head: true }).eq("ig_user_id", igId);
      const { count: emails } = await db.from("ig_contacts").select("*", { count: "exact", head: true }).not("email", "is", null).eq("ig_user_id", igId);
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const { count: sent7 } = await db.from("ig_events").select("*", { count: "exact", head: true }).in("dm_status", ["sent", "resent"]).gte("created_at", since).eq("ig_user_id", igId);
      return json({ metrics: { sent: sent || 0, contacts: contacts || 0, emails: emails || 0, sent7: sent7 || 0 } });
    }

    if (action === "list_media") {
      if (!igId) return json({ media: [] });
      const token = await tokenDe(igId);
      if (!token) return json({ media: [] });
      const limit = Math.min(Number(body.limit ?? 24) || 24, 50);
      const after = String(body.after ?? "").trim();
      const res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${igId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      const b = await res.json().catch(() => ({}));
      const media = Array.isArray(b?.data) ? b.data.map((m: any) => ({ id: m.id, thumb: m.thumbnail_url || m.media_url || "", caption: (m.caption || "").slice(0, 70), type: m.media_type, permalink: m.permalink || "" })) : [];
      const next = (b?.paging?.next && b?.paging?.cursors?.after) ? b.paging.cursors.after : null;
      return json({ media, after: next });
    }

    if (action === "list_stories") {
      if (!igId) return json({ stories: [] });
      const token = await tokenDe(igId);
      if (!token) return json({ stories: [] });
      const res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${igId}/stories?fields=id,media_type,media_url,thumbnail_url,timestamp`, { headers: { Authorization: `Bearer ${token}` } });
      const b = await res.json().catch(() => ({}));
      const stories = Array.isArray(b?.data) ? b.data.map((m: any) => {
        let hace = "";
        if (m.timestamp) { const h = Math.round((Date.now() - new Date(m.timestamp).getTime()) / 3600000); hace = h < 1 ? "hace un rato" : `hace ${h} h`; }
        return { id: String(m.id), thumb: m.thumbnail_url || (m.media_type === "IMAGE" ? m.media_url : "") || "", type: m.media_type, hace };
      }) : [];
      return json({ stories });
    }

    return json({ error: "accion desconocida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
