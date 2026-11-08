// Contestador de Instagram · webhook de Meta (una cuenta).
//
// Qué hace:
//  - GET: verificación del webhook de Meta (hub.verify_token = IG_VERIFY_TOKEN).
//  - POST: comprueba la firma X-Hub-Signature-256 (OBLIGATORIA: sin firma válida, 403)
//    y procesa comentarios (responde en público y manda DM privado con botones),
//    postbacks de botones, DMs con palabra clave, respuestas a historias y FAQs.
//
// Variables de entorno: ver .env.example.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("IG_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("INSTAGRAM_APP_SECRET") ?? "";
// Fallback para instalaciones sin OAuth: token y cuenta fijados por variable de entorno.
const ENV_TOKEN = Deno.env.get("IG_ACCESS_TOKEN") ?? "";
const ENV_ACCOUNT = Deno.env.get("IG_ACCOUNT_ID") ?? "";
const API_VERSION = Deno.env.get("GRAPH_API_VERSION") ?? "v21.0";
const GRAPH_BASE = Deno.env.get("GRAPH_BASE") ?? "https://graph.instagram.com";
// Máximo de DMs enviados por hora (protección frente a ráfagas y bloqueos de Meta).
const MAX_PER_HOUR = Number(Deno.env.get("RATE_LIMIT_PER_HOUR") ?? "200");
// Email (opcionales): si faltan, se omiten sin error.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "";
const EMAIL_WEBHOOK_URL = Deno.env.get("EMAIL_WEBHOOK_URL") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_ROLE);
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const DIA = 24 * 3600 * 1000;
// Pasado este tiempo, ya no se INSISTE pidiendo el email (pero un email válido siempre se captura).
const ESPERA_EMAIL_MS = 6 * 3600 * 1000;

// Erratas típicas de dominio que la gente escribe al dejar su email.
const DOMINIOS_FIX: Record<string, string> = {
  "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gmial.com": "gmail.com", "gmaill.com": "gmail.com",
  "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "gmail.om": "gmail.com", "gmail.comm": "gmail.com",
  "gmail.como": "gmail.com", "gmail.coma": "gmail.com", "gmail.comc": "gmail.com", "gmail.comn": "gmail.com",
  "gmail.comf": "gmail.com", "gmail.com8": "gmail.com", "gmail.com.com": "gmail.com", "gmail.commail.com": "gmail.com",
  "hotmai.com": "hotmail.com", "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "hotmail.co": "hotmail.com", "hotmail.cm": "hotmail.com", "hotmail.come": "hotmail.com",
  "hotmail.comf": "hotmail.com", "hotmail.com4": "hotmail.com",
  "outlok.com": "outlook.com", "outllok.com": "outlook.com", "outlook.co": "outlook.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com",
};

type Account = { id: string; token: string; mlKey?: string; username?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Firma de Meta (X-Hub-Signature-256): HMAC-SHA256 del cuerpo crudo con el secreto de la app.
// ---------------------------------------------------------------------------
async function firmaValida(raw: string, cabecera: string | null): Promise<"ok" | "mal" | "sin_firma" | "sin_secreto"> {
  if (!APP_SECRET) return "sin_secreto";
  if (!cabecera || !cabecera.startsWith("sha256=")) return "sin_firma";
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const esperada = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  const recibida = cabecera.slice(7).trim().toLowerCase();
  if (recibida.length !== esperada.length) return "mal";
  // Comparación en tiempo constante
  let diff = 0;
  for (let i = 0; i < esperada.length; i++) diff |= esperada.charCodeAt(i) ^ recibida.charCodeAt(i);
  return diff === 0 ? "ok" : "mal";
}

// ---------------------------------------------------------------------------
// Cuenta: la de la base de datos (OAuth) o la del entorno (fallback).
// ---------------------------------------------------------------------------
async function resolveAccount(entryId?: string): Promise<Account | null> {
  if (entryId) {
    const { data } = await db.from("ig_accounts")
      .select("ig_user_id,access_token,mailerlite_api_key,username")
      .eq("ig_user_id", entryId).eq("is_active", true).maybeSingle();
    if (data) return {
      id: data.ig_user_id, token: data.access_token,
      mlKey: data.mailerlite_api_key ?? undefined, username: data.username ?? undefined,
    };
  }
  if (ENV_ACCOUNT && ENV_TOKEN && (!entryId || entryId === ENV_ACCOUNT)) {
    return { id: ENV_ACCOUNT, token: ENV_TOKEN };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emparejamiento de palabras clave
// ---------------------------------------------------------------------------

// Normaliza: minúsculas, sin tildes ni diacríticos.
function norm(s: string) {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
// Texto reducido a palabras separadas por espacios (sin signos ni emojis).
function pelarTxt(s: string) {
  return norm(s).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
// Coincidencia "exacta tolerante": ignora signos, y admite una coletilla corta detrás.
function exactoTolerante(cc: string, kk: string): boolean {
  if (cc === kk) return true;
  const pc = pelarTxt(cc), pk = pelarTxt(kk);
  if (pc === pk) return true;
  return pk.length > 0 && pc.startsWith(pk + " ") && pc.length <= pk.length + 16;
}
// Modo "contains" (substring normalizado) o "exact" (tolerante). Varias palabras separadas por coma.
function matches(c: string, k: string, t: string) {
  const cc = norm(c);
  return String(k ?? "").split(",").map((x) => norm(x)).filter(Boolean)
    .some((kk) => (t === "exact" ? exactoTolerante(cc, kk) : cc.includes(kk)));
}
// COMENTARIOS: una regla "exact" acepta la palabra clave dentro de una frase, siempre como palabra entera.
function palabraEnComentario(text: string, keyword: string): boolean {
  const pc = " " + pelarTxt(text) + " ";
  return String(keyword ?? "").split(",").map((x) => pelarTxt(x)).filter(Boolean)
    .some((pk) => pc.includes(" " + pk + " "));
}
function matchesComentario(c: string, k: string, t: string) {
  return t === "exact" ? palabraEnComentario(c, k) : matches(c, k, t);
}
// DM suelto con reglas globales: solo dispara si el mensaje ES la palabra clave.
function dmKeywordExact(text: string, keyword: string) {
  const pt = pelarTxt(text);
  if (!pt) return false;
  return String(keyword ?? "").split(",").map((x) => pelarTxt(x)).filter(Boolean).some((k) => k === pt);
}
// Comodín = palabra clave de 1 letra o solo emoji: responde por DM, pero la respuesta pública solo con palabra real.
function esComodin(k: string) { return pelarTxt(k).length <= 1; }
function casaPalabraReal(text: string, rule: any) {
  const toks = String(rule.keyword ?? "").split(",").filter((x) => x.trim());
  const reales = toks.filter((x) => !esComodin(x));
  if (reales.length === toks.length) return true;
  return reales.length > 0 && matches(text, reales.join(","), rule.match_type);
}

function pickMessage(rule: any) {
  const v: string[] = Array.isArray(rule.reply_variants) ? rule.reply_variants.filter((s: string) => s && s.trim()) : [];
  return v.length ? v[Math.floor(Math.random() * v.length)] : (rule.reply_text ?? "");
}
function pickPublic(rule: any) {
  const v: string[] = Array.isArray(rule.public_replies) ? rule.public_replies.filter((s: string) => s && s.trim()) : [];
  return v.length ? v[Math.floor(Math.random() * v.length)] : null;
}

// ¿El texto es un «sí quiero» (respuesta escrita a un botón)?
function esAfirmacion(t: string, buttonText?: string) {
  const n = norm(t);
  if (!n) return false;
  if (buttonText && n === norm(buttonText)) return true;
  const si = ["si", "si quiero", "siquiero", "quiero", "lo quiero", "la quiero", "los quiero", "las quiero",
    "yes", "claro", "dale", "va", "ok", "vale", "okay", "porfa", "porfavor", "por favor", "me interesa",
    "interesa", "interesado", "interesada", "quiero eso"];
  if (si.includes(n)) return true;
  if (/^si\b/.test(n) && n.length <= 22) return true;
  if (/^(lo|la|los|las)\s+quiero\b/.test(n)) return true;
  if (/^quiero\b/.test(n) && n.length <= 30) return true;
  return false;
}

// Corrige la errata de dominio y detecta el «email basura» (solo números antes de la @).
function arreglarEmail(raw: string): { email: string; basura: boolean } {
  let e = raw.trim().toLowerCase();
  const i = e.lastIndexOf("@");
  if (i < 1) return { email: e, basura: false };
  const loc = e.slice(0, i);
  let dom = e.slice(i + 1);
  if (dom.endsWith(".con")) dom = dom.slice(0, -4) + ".com";
  if (DOMINIOS_FIX[dom]) dom = DOMINIOS_FIX[dom];
  e = loc + "@" + dom;
  return { email: e, basura: /^[0-9]+$/.test(loc) };
}

// ---------------------------------------------------------------------------
// Llamadas a Graph API
// ---------------------------------------------------------------------------
async function igPost(acc: Account, recipient: any, message: any) {
  let last = "";
  for (let intento = 0; intento < 3; intento++) {
    let res: Response;
    try {
      res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${acc.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${acc.token}` },
        body: JSON.stringify({ recipient, message }),
      });
    } catch (e) { last = `fetch: ${e}`; await sleep(1500 * (intento + 1)); continue; }
    const t = await res.text();
    if (res.ok) return t;
    last = `Graph ${res.status}: ${t}`;
    // Reintenta solo errores transitorios (5xx o códigos de límite de Meta 1/2)
    const transitorio = res.status >= 500 || /"code":\s*[12]\b/.test(t);
    if (!transitorio) throw new Error(last);
    await sleep(1500 * (intento + 1));
  }
  throw new Error(last);
}
async function replyToComment(acc: Account, commentId: string, text: string, buttonTitle?: string, payload?: string) {
  if (buttonTitle && payload) {
    return igPost(acc, { comment_id: commentId }, {
      attachment: { type: "template", payload: { template_type: "button", text,
        buttons: [{ type: "postback", title: buttonTitle.slice(0, 20), payload }] } },
    });
  }
  return igPost(acc, { comment_id: commentId }, { text });
}
async function publicCommentReply(acc: Account, commentId: string, text: string) {
  const res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${commentId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${acc.token}` },
    body: JSON.stringify({ message: text }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`Graph ${res.status}: ${t}`);
  return t;
}
async function dm(acc: Account, igsid: string, text: string) { return igPost(acc, { id: igsid }, { text }); }
async function dmButton(acc: Account, igsid: string, text: string, buttonTitle: string, payload: string) {
  return igPost(acc, { id: igsid }, {
    attachment: { type: "template", payload: { template_type: "button", text,
      buttons: [{ type: "postback", title: buttonTitle.slice(0, 20), payload }] } },
  });
}
// Botón «Ver perfil» + botón «ya te sigo» (postback). Si falla, cae a un botón simple.
async function dmFollowGate(acc: Account, igsid: string, text: string, ruleId: string, seguirTitle: string) {
  const btns: any[] = [];
  if (acc.username) btns.push({ type: "web_url", title: "Ver perfil", url: `https://www.instagram.com/${acc.username}/` });
  btns.push({ type: "postback", title: seguirTitle.slice(0, 20), payload: `rule:${ruleId}` });
  try {
    return await igPost(acc, { id: igsid }, {
      attachment: { type: "template", payload: { template_type: "button", text: text.slice(0, 640), buttons: btns } },
    });
  } catch (e) {
    console.error("followGate boton", e);
    return dmButton(acc, igsid, text, seguirTitle, `rule:${ruleId}`);
  }
}
async function dmAttachment(acc: Account, igsid: string, type: "image" | "audio", url: string) {
  return igPost(acc, { id: igsid }, { attachment: { type, payload: { url } } });
}
async function userFollows(acc: Account, igsid: string): Promise<boolean> {
  try {
    const res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${igsid}?fields=is_user_follow_business`, {
      headers: { Authorization: `Bearer ${acc.token}` },
    });
    if (!res.ok) return true;
    const b = await res.json();
    // El campo de Meta es poco fiable: si no responde claramente «false», se da por bueno.
    return b.is_user_follow_business !== false;
  } catch { return true; }
}
async function fetchMediaTimestamp(acc: Account, mediaId: string): Promise<string | null> {
  for (let intento = 0; intento < 3; intento++) {
    try {
      const res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${mediaId}?fields=timestamp`, {
        headers: { Authorization: `Bearer ${acc.token}` },
      });
      if (res.ok) { const b = await res.json(); if (b.timestamp) return b.timestamp; }
    } catch (e) { console.error("mediaTs", e); }
    await sleep(1000 * (intento + 1));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entrega de enlaces y FAQs
// ---------------------------------------------------------------------------
async function entregar(acc: Account, igsid: string, rule: any, fallback: string) {
  if (rule?.image_url) { try { await dmAttachment(acc, igsid, "image", rule.image_url); } catch (e) { console.error("adjunto imagen", e); } }
  if (rule?.audio_url) { try { await dmAttachment(acc, igsid, "audio", rule.audio_url); } catch (e) { console.error("adjunto audio", e); } }
  const texto = (rule?.final_message && rule.final_message.trim()) || fallback;
  const btns: any[] = [];
  const urls: string[] = [];
  for (const [t, u] of [
    [rule?.link_button_text, rule?.link_button_url],
    [rule?.link_button2_text, rule?.link_button2_url],
    [rule?.link_button3_text, rule?.link_button3_url],
  ]) {
    const bt = String(t ?? "").trim(), bu = String(u ?? "").trim();
    if (bt && /^https?:\/\//i.test(bu)) { btns.push({ type: "web_url", title: bt.slice(0, 20), url: bu }); urls.push(bu); }
  }
  if (btns.length) {
    try {
      await igPost(acc, { id: igsid }, {
        attachment: { type: "template", payload: { template_type: "button", text: texto.slice(0, 640), buttons: btns } },
      });
      return;
    } catch (e) {
      // Si Meta rechaza los botones, se manda el texto con los enlaces escritos.
      console.error("boton enlace", e);
      await dm(acc, igsid, texto + "\n" + urls.join("\n"));
      return;
    }
  }
  await dm(acc, igsid, texto);
}
async function responderFaq(acc: Account, igsid: string, faq: any, via: string) {
  if (faq.image_url) { try { await dmAttachment(acc, igsid, "image", faq.image_url); } catch (e) { console.error("faq img", e); } }
  const btnT = (faq.link_button_text ?? "").trim(), btnU = (faq.link_button_url ?? "").trim();
  if (btnT && /^https?:\/\//i.test(btnU)) {
    try {
      await igPost(acc, { id: igsid }, {
        attachment: { type: "template", payload: { template_type: "button", text: String(faq.respuesta).slice(0, 640),
          buttons: [{ type: "web_url", title: btnT.slice(0, 20), url: btnU }] } },
      });
    } catch (e) { console.error("faq boton", e); await dm(acc, igsid, faq.respuesta + "\n" + btnU); }
  } else {
    await dm(acc, igsid, faq.respuesta);
  }
  await upsertContact(igsid, undefined, undefined, acc.id);
  await db.from("ig_contacts").update({ last_faq_at: new Date().toISOString(), last_faq_id: faq.id }).eq("igsid", igsid);
  await db.from("ig_faq_hits").insert({ faq_id: faq.id, igsid, via });
}

// ---------------------------------------------------------------------------
// Base de datos: contactos, entregas, reintentos
// ---------------------------------------------------------------------------
async function upsertContact(igsid?: string, username?: string, email?: string, accId?: string) {
  if (!igsid) return;
  const { data } = await db.from("ig_contacts").select("id,interactions,ig_user_id").eq("igsid", igsid).maybeSingle();
  if (data) {
    await db.from("ig_contacts").update({
      username: username ?? undefined, email: email ?? undefined,
      ig_user_id: data.ig_user_id ?? accId ?? undefined,
      interactions: (data.interactions ?? 1) + 1, last_seen: new Date().toISOString(),
    }).eq("id", data.id);
  } else {
    await db.from("ig_contacts").insert({ igsid, username, email, ig_user_id: accId ?? null });
  }
}
// Marca la entrega. Devuelve false si ya se había entregado a esa persona.
async function primeraEntrega(ruleId: string, igsid: string): Promise<boolean> {
  const { error } = await db.from("ig_entregas").insert({ rule_id: ruleId, igsid });
  if (!error) return true;
  if ((error as any).code === "23505") return false;
  console.error("ig_entregas", error);
  return true;
}
// ¿Se puede volver a entregar? Sí si el último clic fue hace más de 10 minutos.
async function reentregable(ruleId: string, igsid: string): Promise<boolean> {
  const { data } = await db.from("ig_clicks").select("created_at")
    .eq("rule_id", ruleId).eq("igsid", igsid).order("created_at", { ascending: false }).limit(2);
  if (!data || data.length < 2) return true;
  return Date.now() - new Date(data[1].created_at).getTime() > 10 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Email capturado: se guarda, se sincroniza con MailerLite (si hay clave),
// se reenvía a EMAIL_WEBHOOK_URL (si existe) y se manda bienvenida (si hay Resend).
// Cada paso es opcional: si falta su variable, se omite con un log.
// ---------------------------------------------------------------------------
async function addToMailerLite(mlKey: string | undefined, email: string, groupId?: string) {
  if (!mlKey) return { skipped: "no_key" };
  const body: any = { email };
  if (groupId) body.groups = [groupId];
  const res = await fetch("https://connect.mailerlite.com/api/subscribers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${mlKey}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}
async function alCapturarEmail(acc: Account, igsid: string, email: string, etiqueta?: string | null) {
  try {
    // ¿Es la primera vez que este email aparece en la lista? (para la bienvenida)
    const { data: otro } = await db.from("ig_contacts").select("id").eq("email", email).neq("igsid", igsid).limit(1);
    const nuevo = !(otro && otro.length);

    if (EMAIL_WEBHOOK_URL) {
      try {
        const r = await fetch(EMAIL_WEBHOOK_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, etiqueta: etiqueta ?? null, ig_user_id: acc.id, username: acc.username ?? null, origen: "contestador", fecha: new Date().toISOString() }),
        });
        if (!r.ok) console.error("EMAIL_WEBHOOK_URL respondió", r.status);
      } catch (e) { console.error("EMAIL_WEBHOOK_URL", e); }
    } else {
      console.log("alCapturarEmail: EMAIL_WEBHOOK_URL no definida, no se reenvía el email");
    }

    if (nuevo) {
      if (!RESEND_API_KEY || !EMAIL_FROM) {
        console.log("bienvenida: faltan RESEND_API_KEY o EMAIL_FROM, no se envía");
        return;
      }
      const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1e2a24;font-size:16px;line-height:1.6;max-width:560px;margin:0 auto;padding:24px">
  <p>¡Gracias por dejarnos tu email!</p>
  <p>Si aún no has abierto lo que te enviamos por Instagram, revisa tus mensajes directos.</p>
</div>`;
      const rr = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: EMAIL_FROM, to: [email], subject: "Gracias por tu email", html }),
      });
      if (!rr.ok) console.error("correo bienvenida", rr.status, (await rr.text()).slice(0, 200));
    }
  } catch (e) { console.error("alCapturarEmail", e); }
}

// ---------------------------------------------------------------------------
// Resolución de regla para un comentario
// ---------------------------------------------------------------------------
async function resolveRule(acc: Account, rules: any[], text: string, mediaId?: string): Promise<{ rule: any | null; nota?: string }> {
  const cand = (rules || []).filter((r: any) => {
    if (typeof r.media_id === "string" && (r.media_id === "STORIES" || r.media_id.startsWith("STORY:"))) return false;
    return matchesComentario(text, r.keyword, r.match_type);
  });
  // 1) regla de ese post concreto gana a la global
  const exacta = cand.find((r: any) => r.media_id === mediaId);
  if (exacta) return { rule: exacta };
  // 2) regla «NEXT»: se aplica al primer post publicado después de crearla
  for (const r of cand) {
    if (r.media_id === "NEXT" && r.next_after && mediaId) {
      const ts = await fetchMediaTimestamp(acc, mediaId);
      if (ts) {
        if (new Date(ts) >= new Date(r.next_after)) {
          await db.from("ig_rules").update({ media_id: mediaId, next_after: null }).eq("id", r.id);
          return { rule: r };
        }
      } else {
        console.warn(`NEXT sin fecha de post ${mediaId} para la regla ${r.keyword}: se entrega igualmente`);
        return { rule: r, nota: "entregado sin poder comprobar la fecha del post" };
      }
    }
  }
  // 3) regla global
  const global = cand.find((r: any) => !r.media_id);
  if (global) return { rule: global };
  return { rule: null };
}

// ---------------------------------------------------------------------------
// Comentarios
// ---------------------------------------------------------------------------
async function handleComment(acc: Account, v: any) {
  const commentId = v.id, text = v.text ?? "";
  const commenterId = v.from?.id, commenterUser = v.from?.username, mediaId = v.media?.id;
  if (!commentId) return;
  // Respuestas de la propia cuenta a un comentario: no se procesan
  const esLaDuena = Boolean(commenterId && commenterId === acc.id);
  if (esLaDuena && (v.parent_id || v.parent)) return;

  const { error } = await db.from("ig_events").insert({
    comment_id: commentId, commenter_id: commenterId, commenter_username: commenterUser,
    media_id: mediaId, comment_text: text, dm_status: "pending", ig_user_id: acc.id,
  });
  if (error) { if ((error as any).code === "23505") return; console.error(error); return; }
  await upsertContact(commenterId, commenterUser, undefined, acc.id);

  const { data: rules } = await db.from("ig_rules").select("*").eq("is_active", true).eq("ig_user_id", acc.id);
  const { rule } = await resolveRule(acc, rules ?? [], text, mediaId);
  if (!rule) { await db.from("ig_events").update({ dm_status: "skipped" }).eq("comment_id", commentId); return; }

  // Repetición: si ya se le envió esta regla hace poco, no se vuelve a mandar
  let repeticion = false;
  if (commenterId) {
    const { data: prev } = await db.from("ig_events").select("id").eq("commenter_id", commenterId)
      .eq("matched_rule_id", rule.id).eq("dm_status", "sent").limit(1);
    if (prev && prev.length) {
      const hace24 = new Date(Date.now() - DIA).toISOString();
      const { data: re } = await db.from("ig_events").select("id").eq("commenter_id", commenterId)
        .eq("matched_rule_id", rule.id).eq("dm_status", "resent").gte("created_at", hace24).limit(1);
      if (re && re.length) {
        await db.from("ig_events").update({ dm_status: "duplicate", matched_rule_id: rule.id }).eq("comment_id", commentId);
        return;
      }
      repeticion = true;
    }
  }
  // Tope por hora
  const since = new Date(Date.now() - 3600000).toISOString();
  const { count } = await db.from("ig_events").select("*", { count: "exact", head: true })
    .eq("dm_status", "sent").eq("ig_user_id", acc.id).gte("created_at", since);
  if ((count ?? 0) >= MAX_PER_HOUR) {
    await db.from("ig_events").update({ dm_status: "throttled", matched_rule_id: rule.id }).eq("comment_id", commentId);
    return;
  }

  try {
    if (rule.button_text) await replyToComment(acc, commentId, pickMessage(rule), rule.button_text, `rule:${rule.id}`);
    else await replyToComment(acc, commentId, pickMessage(rule));
    await db.from("ig_events").update({ dm_status: repeticion ? "resent" : "sent", matched_rule_id: rule.id }).eq("comment_id", commentId);
  } catch (e) {
    await db.from("ig_events").update({ dm_status: "error", dm_error: String(e), matched_rule_id: rule.id }).eq("comment_id", commentId);
    console.error("reply error", e);
    // Si Instagram no admite el DM porque la cuenta tiene los mensajes cerrados a no seguidores
    // (subcode 2534025), se deja UN comentario público pidiendo que siga la cuenta.
    if (!repeticion && !esLaDuena && /2534025|invalid for a private reply/i.test(String(e))) {
      try {
        await publicCommentReply(acc, commentId, "¡Te he intentado escribir por privado pero Instagram no me deja llegar a ti! 🙈 Pasa cuando tienes cerrados los mensajes a quien no te sigue. Sígueme y coméntalo otra vez y te lo mando al momento 💚");
        await db.from("ig_events").update({ public_reply_status: "seguime" }).eq("comment_id", commentId);
      } catch (_) { /* sin más reintentos */ }
    }
    return;
  }

  // Respuesta pública (solo si la palabra clave es real, no un comodín)
  const pub = pickPublic(rule);
  if (pub && !repeticion && !esLaDuena && casaPalabraReal(text, rule)) {
    try {
      await publicCommentReply(acc, commentId, pub);
      await db.from("ig_events").update({ public_reply_status: "sent" }).eq("comment_id", commentId);
    } catch (e) {
      await db.from("ig_events").update({ public_reply_status: ("error: " + String(e)).slice(0, 200) }).eq("comment_id", commentId);
      console.error("public reply error", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Postbacks (botones) y DMs
// ---------------------------------------------------------------------------
async function handlePostback(acc: Account, m: any) {
  const igsid = m.sender?.id;
  const payload: string = m.postback?.payload ?? "";
  if (!igsid) return;

  if (payload.startsWith("faq:")) {
    const { data: faq } = await db.from("ig_faqs").select("*").eq("id", payload.slice(4)).eq("is_active", true).maybeSingle();
    if (faq && String(faq.ig_user_id) === String(acc.id)) await responderFaq(acc, igsid, faq, "menu");
    return;
  }
  if (!payload.startsWith("rule:")) return;

  const ruleId = payload.slice(5);
  const { data: rule } = await db.from("ig_rules").select("*").eq("id", ruleId).maybeSingle();
  if (!rule) return;
  await db.from("ig_clicks").insert({ rule_id: ruleId, igsid });
  await upsertContact(igsid, undefined, undefined, acc.id);

  // Imagen al primer clic
  if (rule.click_image_url) {
    try {
      const { count: nClicks } = await db.from("ig_clicks").select("*", { count: "exact", head: true })
        .eq("rule_id", ruleId).eq("igsid", igsid);
      if ((nClicks ?? 1) <= 1) await dmAttachment(acc, igsid, "image", rule.click_image_url);
    } catch (e) { console.error("click image", e); }
  }

  // Exigir seguir la cuenta
  if (rule.require_follow) {
    const sigue = await userFollows(acc, igsid);
    if (!sigue) {
      const { count: nClicks } = await db.from("ig_clicks").select("*", { count: "exact", head: true })
        .eq("rule_id", ruleId).eq("igsid", igsid);
      const clicks = nClicks ?? 1;
      // Si Instagram sigue diciendo «no sigue» tras varios toques, se entrega igual (el campo de Meta falla a veces).
      if (clicks < 3) {
        if (clicks > 1) {
          const txt2 = "¡Ups! Pues Instagram me dice que aún no me sigues 🙈 A veces tarda un minutito en enterarse. Toca «Ver perfil», dale a Seguir y vuelve a pulsar el botón, que te lo mando al momento.";
          await dmFollowGate(acc, igsid, txt2, rule.id, "¡Listo, ya te sigo!");
        } else {
          const txt = (rule.follow_prompt && rule.follow_prompt.trim()) || "¡Ya casi está! Para poder enviártelo necesito que me sigas 😊 Toca «Ver perfil», dale a Seguir y vuelve aquí a pulsar «¡Ya te sigo!» 👇";
          await dmFollowGate(acc, igsid, txt, rule.id, "¡Ya te sigo!");
        }
        return;
      }
    }
  }

  if (rule.ask_email) {
    const { data: contacto } = await db.from("ig_contacts").select("email").eq("igsid", igsid).maybeSingle();
    // Si ya dejó un email antes, no se le vuelve a pedir: se corrige la errata y se entrega directo.
    const previo = contacto?.email && EMAIL_RE.test(contacto.email) ? arreglarEmail(contacto.email) : null;
    const emailPrevio = previo && !previo.basura ? previo.email : null;
    if (emailPrevio) {
      await db.from("ig_conversations").upsert({ igsid, rule_id: ruleId, state: "done", email: emailPrevio, ig_user_id: acc.id, updated_at: new Date().toISOString() }, { onConflict: "igsid" });
      if (await primeraEntrega(ruleId, igsid)) {
        try { const r = await addToMailerLite(acc.mlKey, emailPrevio, rule?.mailerlite_group_id); console.log("mailerlite (email previo)", JSON.stringify(r)); } catch (e) { console.error("ml", e); }
        await alCapturarEmail(acc, igsid, emailPrevio, rule?.etiqueta);
        await entregar(acc, igsid, rule, "¡Listo! Aquí tienes lo que pedías 👇");
      } else if (await reentregable(ruleId, igsid)) {
        await entregar(acc, igsid, rule, "¡Listo! Aquí lo tienes otra vez 👇");
      }
      return;
    }
    await db.from("ig_conversations").upsert({ igsid, rule_id: ruleId, state: "awaiting_email", email_intentos: 0, ig_user_id: acc.id, updated_at: new Date().toISOString() }, { onConflict: "igsid" });
    await dm(acc, igsid, rule.email_prompt || "¡Genial! Déjame tu email y te lo envío ✍️");
  } else if (await primeraEntrega(ruleId, igsid)) {
    await entregar(acc, igsid, rule, pickMessage(rule));
  } else if (await reentregable(ruleId, igsid)) {
    await entregar(acc, igsid, rule, pickMessage(rule));
  }
}

async function handleMessage(acc: Account, m: any) {
  // Eco de un mensaje enviado por la propia cuenta: marca que una persona ha contestado a mano
  if (m.message?.is_echo) {
    const rid = m.recipient?.id;
    if (rid) await db.from("ig_contacts").update({ last_human_at: new Date().toISOString() }).eq("igsid", rid);
    return;
  }
  const igsid = m.sender?.id;
  const text = (m.message?.text ?? "").trim();
  if (!igsid || !text) return;

  const { data: conv } = await db.from("ig_conversations").select("*").eq("igsid", igsid).maybeSingle();

  // Captura de email pendiente
  const pendiente = !!(conv && conv.rule_id && conv.state !== "done");
  if (pendiente) {
    const match = text.match(EMAIL_RE);
    if (match) {
      const arreglado = arreglarEmail(match[0]);
      if (arreglado.basura) {
        // Solo números antes de la @: se pide uno de verdad, hasta 2 veces, y no se guarda.
        const intentosB = conv.email_intentos ?? 0;
        if (conv.state === "awaiting_email" && intentosB < 2) {
          await db.from("ig_conversations").update({ email_intentos: intentosB + 1, updated_at: new Date().toISOString() }).eq("igsid", igsid);
          await dm(acc, igsid, "Mmm, ese correo son solo números y no me va a llegar 🙈 Ponme el tuyo de verdad (algo tipo nombre@correo.com) y te lo mando al momento 👇");
        }
        return;
      }
      const email = arreglado.email;
      const { data: rule } = await db.from("ig_rules").select("*").eq("id", conv.rule_id).maybeSingle();
      await db.from("ig_conversations").update({ state: "done", email, updated_at: new Date().toISOString() }).eq("igsid", igsid);
      await upsertContact(igsid, undefined, email, acc.id);
      try { const r = await addToMailerLite(acc.mlKey, email, rule?.mailerlite_group_id); console.log("mailerlite", JSON.stringify(r)); } catch (e) { console.error("ml", e); }
      await alCapturarEmail(acc, igsid, email, rule?.etiqueta);
      if (await primeraEntrega(conv.rule_id, igsid)) await entregar(acc, igsid, rule, "¡Listo! Aquí tienes lo que pedías 👇");
      else if (await reentregable(conv.rule_id, igsid)) await entregar(acc, igsid, rule, "¡Listo! Aquí lo tienes otra vez 👇");
      return;
    }
    if (conv.state === "awaiting_email") {
      const fresca = conv.updated_at && (Date.now() - new Date(conv.updated_at).getTime() < ESPERA_EMAIL_MS);
      const intentos = conv.email_intentos ?? 0;
      // Si dicen que NO quieren dejar el email, se recuerda (hasta 2 veces) que hace falta. Nunca se entrega sin email.
      const n = norm(text);
      const declina = n === "no" || n === "nop" || n === "nel" ||
        /(no\s*gracias|no\s*quiero|no\s*te?\s*lo?\s*doy|no\s*doy|sin\s*(email|correo|mail)|no\s*hace\s*falta|prefiero\s*no|mejor\s*no|^paso$|me\s*vale|asi\s*vale|no\s*quiero\s*(dar|dejar|poner))/.test(n);
      if (fresca && declina && intentos < 2) {
        await db.from("ig_conversations").update({ email_intentos: intentos + 1, updated_at: new Date().toISOString() }).eq("igsid", igsid);
        await dm(acc, igsid, "La guía te la paso justo por aquí, pero necesito tu email para poder enviártela 🙏 Déjamelo (algo tipo nombre@correo.com) y en un momentito la tienes 👇");
        return;
      }
      // Parece un email mal escrito: se pide otra vez (hasta 2 veces)
      const pareceIntento = /@/.test(text) || /[a-z0-9._-]+\.(com|es|net|org|info|io|co|eu|gmail|hotmail|outlook|yahoo|icloud)/i.test(text);
      if (fresca && pareceIntento && intentos < 2) {
        const nudge = intentos === 0
          ? "Mmm, eso no parece un email 😅 Escríbemelo enterito (algo tipo nombre@correo.com) y te lo paso 👇"
          : "Casi 😄 pero sigue sin ser un email válido. Míralo bien (nombre@correo.com) y me lo mandas 🙌";
        await db.from("ig_conversations").update({ email_intentos: intentos + 1, updated_at: new Date().toISOString() }).eq("igsid", igsid);
        await dm(acc, igsid, nudge);
        return;
      }
      if (!fresca) await db.from("ig_conversations").update({ state: "expirada" }).eq("igsid", igsid);
      return; // silencio: ni molesta ni secuestra
    }
    // estado 'expirada' u otro + no es email → sigue al flujo normal
  }

  // Respondió con PALABRAS a un botón («Si quiero» en vez de pulsarlo): se trata como si lo hubiera pulsado.
  if (!conv || conv.state === "done" || conv.state === "expirada") {
    const hace48 = new Date(Date.now() - 2 * DIA).toISOString();
    const { data: ev } = await db.from("ig_events").select("matched_rule_id").eq("commenter_id", igsid)
      .in("dm_status", ["sent", "resent"]).not("matched_rule_id", "is", null).gte("created_at", hace48)
      .order("created_at", { ascending: false }).limit(1);
    if (ev && ev.length) {
      const { data: rule } = await db.from("ig_rules").select("id,button_text,ig_user_id").eq("id", ev[0].matched_rule_id).maybeSingle();
      if (rule && String(rule.ig_user_id) === String(acc.id) && rule.button_text && esAfirmacion(text, rule.button_text)) {
        const { count: yaClick } = await db.from("ig_clicks").select("*", { count: "exact", head: true })
          .eq("rule_id", rule.id).eq("igsid", igsid);
        if ((yaClick ?? 0) === 0) {
          await handlePostback(acc, { sender: { id: igsid }, postback: { payload: `rule:${rule.id}` } });
          return;
        }
      }
    }
  }

  // Respuesta a una historia
  const esStory = !!(m.message?.reply_to?.story) ||
    (Array.isArray(m.message?.attachments) && m.message.attachments.some((a: any) => a?.type === "story_mention"));
  if (esStory) {
    const storyId = String(m.message?.reply_to?.story?.id ?? "").trim();
    const orCond = "media_id.is.null,media_id.eq.STORIES" + (storyId ? `,media_id.eq.STORY:${storyId}` : "");
    const { data: rules } = await db.from("ig_rules").select("*").eq("is_active", true).eq("ig_user_id", acc.id).or(orCond);
    const peso = (r: any) => (storyId && r.media_id === `STORY:${storyId}`) ? 2 : (r.media_id === "STORIES" ? 1 : 0);
    const cands = (rules ?? []).sort((a: any, b: any) => peso(b) - peso(a));
    // Respuesta a historia: match ANCLADO, para no disparar con mensajes normales
    const rule = cands.find((r: any) => matches(text, r.keyword, "exact"));
    if (rule) {
      const mid = m.message?.mid || `story-${igsid}-${m.timestamp || ""}`;
      const { error } = await db.from("ig_events").insert({ comment_id: mid, commenter_id: igsid, media_id: null, comment_text: text, dm_status: "pending", ig_user_id: acc.id, origen: "story" });
      if (error) { if ((error as any).code === "23505") return; console.error(error); }
      await upsertContact(igsid, undefined, undefined, acc.id);
      let repe = false;
      const { data: prev } = await db.from("ig_events").select("id").eq("commenter_id", igsid).eq("matched_rule_id", rule.id).eq("dm_status", "sent").limit(1);
      if (prev && prev.length) {
        const hace24 = new Date(Date.now() - DIA).toISOString();
        const { data: re } = await db.from("ig_events").select("id").eq("commenter_id", igsid).eq("matched_rule_id", rule.id).eq("dm_status", "resent").gte("created_at", hace24).limit(1);
        if (re && re.length) { await db.from("ig_events").update({ dm_status: "duplicate", matched_rule_id: rule.id }).eq("comment_id", mid); return; }
        repe = true;
      }
      try {
        if (rule.button_text) await dmButton(acc, igsid, pickMessage(rule), rule.button_text, `rule:${rule.id}`);
        else await dm(acc, igsid, pickMessage(rule));
        await db.from("ig_events").update({ dm_status: repe ? "resent" : "sent", matched_rule_id: rule.id }).eq("comment_id", mid);
      } catch (e) {
        await db.from("ig_events").update({ dm_status: "error", dm_error: String(e), matched_rule_id: rule.id }).eq("comment_id", mid);
        console.error("story reply error", e);
      }
      return;
    }
  }

  // Si una persona contestó a mano hace menos de 24 h, el bot calla.
  const { data: contacto } = await db.from("ig_contacts").select("last_human_at,last_faq_at,last_faq_id").eq("igsid", igsid).maybeSingle();
  if (contacto?.last_human_at && Date.now() - new Date(contacto.last_human_at).getTime() < DIA) return;

  // Palabra clave escrita por DM directo: se atiende como si hubiera pulsado el botón de esa regla.
  const { data: rulesDm } = await db.from("ig_rules").select("*").eq("is_active", true).eq("ig_user_id", acc.id);
  const cand = (rulesDm ?? []).filter((r: any) => {
    if (typeof r.media_id === "string" && (r.media_id === "STORIES" || r.media_id.startsWith("STORY:"))) return false;
    const esReel = typeof r.media_id === "string" && /^[0-9]+$/.test(r.media_id);
    return esReel ? matches(text, r.keyword, "exact") : dmKeywordExact(text, r.keyword);
  });
  if (cand.length) {
    cand.sort((a: any, b: any) => {
      const ar = /^[0-9]+$/.test(String(a.media_id || "")), br = /^[0-9]+$/.test(String(b.media_id || ""));
      if (ar !== br) return ar ? -1 : 1;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
    const rule = cand[0];
    const mid = m.message?.mid || `dm-${igsid}-${m.timestamp || Date.now()}`;
    try {
      await db.from("ig_events").insert({ comment_id: mid, commenter_id: igsid, media_id: (/^[0-9]+$/.test(String(rule.media_id || "")) ? rule.media_id : null), comment_text: text, dm_status: "sent", matched_rule_id: rule.id, ig_user_id: acc.id, origen: "dm" });
    } catch (_e) { /* ya registrado */ }
    await handlePostback(acc, { sender: { id: igsid }, postback: { payload: `rule:${rule.id}` } });
    return;
  }

  // FAQs por palabras clave
  const { data: faqs } = await db.from("ig_faqs").select("*").eq("is_active", true).eq("ig_user_id", acc.id);
  const faq = (faqs ?? []).find((f) => matches(text, f.keywords, "contains"));
  if (!faq) return;
  if (contacto?.last_faq_id === faq.id && contacto?.last_faq_at && Date.now() - new Date(contacto.last_faq_at).getTime() < DIA) return;
  await responderFaq(acc, igsid, faq, "dm");
}

// ---------------------------------------------------------------------------
// Entrada HTTP
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verificación del webhook por Meta
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && VERIFY_TOKEN &&
        url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Firma de Meta OBLIGATORIA: lo que no venga firmado con INSTAGRAM_APP_SECRET se rechaza.
  const raw = await req.text();
  let firma = "error";
  try { firma = await firmaValida(raw, req.headers.get("x-hub-signature-256")); } catch (e) { console.error("firma", e); }
  console.log(firma === "ok" ? "firma ok" : `firma MAL (${firma})`);
  if (firma !== "ok") return new Response("Forbidden", { status: 403 });

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  try {
    for (const entry of payload?.entry ?? []) {
      const acc = await resolveAccount(entry?.id ? String(entry.id) : undefined);
      if (!acc) { console.error("cuenta desconocida", entry?.id); continue; }
      for (const change of entry?.changes ?? []) {
        if (change.field === "comments") await handleComment(acc, change.value ?? {});
      }
      for (const m of entry?.messaging ?? []) {
        if (m.postback) await handlePostback(acc, m);
        else if (m.message) await handleMessage(acc, m);
      }
    }
  } catch (e) { console.error("handler", e); }
  // Siempre 200 una vez verificada la firma, para que Meta no reintente en bucle.
  return new Response("EVENT_RECEIVED", { status: 200 });
});
