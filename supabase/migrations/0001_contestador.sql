-- ============================================================================
-- Contestador de Instagram · esquema para UNA cuenta
-- Idempotente en lo razonable: se puede ejecutar más de una vez.
-- Todas las tablas tienen RLS activado SIN políticas públicas: solo el
-- service role (las Edge Functions) puede leer y escribir. El panel habla
-- con las funciones (ig-admin, ig-link-stats), nunca directamente con la BD.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Cuenta de Instagram conectada (una fila; se crea con el login de OAuth)
-- ---------------------------------------------------------------------------
create table if not exists public.ig_accounts (
  id                 uuid primary key default gen_random_uuid(),
  ig_user_id         text not null unique,
  username           text,
  -- Token de Instagram. Vive aquí pero solo el service role puede leerlo (RLS sin políticas).
  access_token       text not null,
  token_expires_at   timestamptz,
  last_refreshed_at  timestamptz default now(),
  is_active          boolean not null default true,
  -- Clave opcional de MailerLite para esta cuenta (si la conectas desde el panel).
  mailerlite_api_key text,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Automatizaciones (palabra clave → respuesta pública + DM con botones)
-- ---------------------------------------------------------------------------
create table if not exists public.ig_rules (
  id                  uuid primary key default gen_random_uuid(),
  ig_user_id          text not null,
  keyword             text not null,
  match_type          text not null default 'contains' check (match_type in ('contains', 'exact')),
  reply_text          text not null,                 -- primera variante (compatibilidad)
  reply_variants      text[],                        -- variantes de la respuesta al comentario
  public_replies      jsonb,                         -- respuestas públicas (array de strings)
  media_id            text,                          -- null = global; id = post concreto; STORIES; STORY:<id>; NEXT
  next_after          timestamptz,                   -- para media_id = NEXT: primer post publicado después de esta fecha
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  image_url           text,
  audio_url           text,
  click_image_url     text,
  button_text         text,                          -- botón «postback» del DM (si null, DM de texto)
  ask_email           boolean not null default false,
  email_prompt        text,
  final_message       text,
  require_follow      boolean not null default false,
  follow_prompt       text,
  link_button_text    text,
  link_button_url     text,
  link_button2_text   text,
  link_button2_url    text,
  link_button3_text   text,
  link_button3_url    text,
  etiqueta            text,                          -- etiqueta libre para segmentar leads
  mailerlite_group_id text,                          -- grupo de MailerLite donde meter al lead (opcional)
  en_historias        boolean default false,         -- crea una regla gemela STORIES automáticamente
  twin_de             uuid                           -- id de la regla original si esta es la gemela de historias
);
create index if not exists ig_rules_account_idx on public.ig_rules (ig_user_id, is_active);

-- ---------------------------------------------------------------------------
-- Eventos: cada comentario o DM que ha pasado por el bot (log y deduplicación)
-- ---------------------------------------------------------------------------
create table if not exists public.ig_events (
  id                   uuid primary key default gen_random_uuid(),
  comment_id           text not null unique,         -- id del comentario (o del mensaje) de Meta
  commenter_id         text,
  commenter_username   text,
  media_id             text,
  comment_text         text,
  matched_rule_id      uuid references public.ig_rules (id) on delete set null,
  dm_status            text not null default 'pending',  -- pending|sent|resent|duplicate|skipped|throttled|error
  dm_error             text,
  public_reply_status  text,
  origen               text,                          -- null = comentario; 'story' o 'dm'
  ig_user_id           text,
  created_at           timestamptz not null default now()
);
create index if not exists ig_events_account_idx on public.ig_events (ig_user_id, created_at desc);
create index if not exists ig_events_created_idx on public.ig_events (created_at desc);
create index if not exists ig_events_commenter_idx on public.ig_events (commenter_id, matched_rule_id);

-- ---------------------------------------------------------------------------
-- Clics en botones de enlace (ig-click) y registro del botón pulsado
-- ---------------------------------------------------------------------------
create table if not exists public.ig_clicks (
  id          uuid primary key default gen_random_uuid(),
  rule_id     uuid references public.ig_rules (id) on delete cascade,
  igsid       text,
  created_at  timestamptz not null default now()
);
create index if not exists ig_clicks_rule_idx on public.ig_clicks (rule_id);

create table if not exists public.ig_link_clicks (
  id          bigint generated always as identity primary key,
  rule_id     uuid references public.ig_rules (id) on delete cascade,
  igsid       text,
  boton       text,
  url         text,
  ig_user_id  text,
  created_at  timestamptz not null default now()
);
create index if not exists ig_link_clicks_rule_idx on public.ig_link_clicks (rule_id);
create index if not exists ig_link_clicks_igsid_idx on public.ig_link_clicks (igsid);

-- Entregas: una por persona y regla (evita entregar dos veces el mismo regalo)
create table if not exists public.ig_entregas (
  rule_id     uuid not null references public.ig_rules (id) on delete cascade,
  igsid       text not null,
  created_at  timestamptz not null default now(),
  primary key (rule_id, igsid)
);

-- ---------------------------------------------------------------------------
-- Contactos y leads: personas que han interactuado (y su email si lo dejan)
-- ---------------------------------------------------------------------------
create table if not exists public.ig_contacts (
  id            uuid primary key default gen_random_uuid(),
  igsid         text unique,
  username      text,
  email         text,                                -- lead capturado (ask_email)
  interactions  integer not null default 1,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  last_human_at timestamptz,                         -- última respuesta humana (el bot calla 24 h)
  last_faq_at   timestamptz,
  last_faq_id   uuid,
  ig_user_id    text
);
create index if not exists ig_contacts_email_idx on public.ig_contacts (email);

-- Conversaciones en curso (esperando email, etc.)
create table if not exists public.ig_conversations (
  id              uuid primary key default gen_random_uuid(),
  igsid           text not null unique,
  rule_id         uuid references public.ig_rules (id) on delete set null,
  state           text not null default 'awaiting_email',  -- awaiting_email | done | expirada
  email           text,
  email_intentos  integer default 0,
  ig_user_id      text,
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Preguntas frecuentes (FAQ) que el bot responde por DM y menú del chat
-- ---------------------------------------------------------------------------
create table if not exists public.ig_faqs (
  id                uuid primary key default gen_random_uuid(),
  ig_user_id        text not null,
  pregunta          text not null,                  -- texto del menú (máx. 80)
  keywords          text not null,                  -- palabras separadas por comas
  respuesta         text not null,
  image_url         text,
  link_button_text  text,
  link_button_url   text,
  en_menu           boolean not null default false,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

create table if not exists public.ig_faq_hits (
  id          bigint generated always as identity primary key,
  faq_id      uuid references public.ig_faqs (id) on delete cascade,
  igsid       text,
  via         text,                                -- 'menu' | 'dm'
  created_at  timestamptz not null default now()
);
create index if not exists ig_faq_hits_faq_idx on public.ig_faq_hits (faq_id);

-- ---------------------------------------------------------------------------
-- Diagnóstico de OAuth y de errores (sin tokens completos)
-- ---------------------------------------------------------------------------
create table if not exists public.ig_raw (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  payload     jsonb
);

-- ---------------------------------------------------------------------------
-- Seguridad: RLS activado en todas, sin políticas; solo service_role.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tablas text[] := array[
    'ig_accounts', 'ig_rules', 'ig_events', 'ig_clicks', 'ig_link_clicks',
    'ig_entregas', 'ig_contacts', 'ig_conversations', 'ig_faqs', 'ig_faq_hits', 'ig_raw'
  ];
begin
  foreach t in array tablas loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- Secuencias de las columnas identity (ig_link_clicks, ig_faq_hits)
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Bucket público para imágenes y audios de las automatizaciones (upload_media)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('ig-autodm', 'ig-autodm', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- OPCIONAL · renovación semanal de tokens con pg_cron + pg_net.
-- Descomenta, sustituye los placeholders y ejecútalo en el SQL editor.
-- El secreto va en la CABECERA x-cron-secret (nunca en la URL).
-- ---------------------------------------------------------------------------
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select cron.schedule(
--   'ig-refresh-semanal',
--   '0 6 * * 1',
--   $$
--   select net.http_post(
--     url := 'https://TU-PROYECTO.supabase.co/functions/v1/ig-refresh',
--     headers := jsonb_build_object('x-cron-secret', 'TU_CRON_SECRET'),
--     body := '{}'::jsonb
--   );
--   $$
-- );
