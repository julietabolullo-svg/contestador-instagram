# Notas técnicas · Contestador de Instagram (versión de una cuenta)

Cómo se comporta, cómo está protegido y qué conviene saber antes de tocarlo.

## 1. Comportamiento

- **Webhook de Meta**: verificación GET con `IG_VERIFY_TOKEN`; en POST, firma `X-Hub-Signature-256` **obligatoria** (sin firma válida, 403).
- **Comentarios**: respuesta pública con `reply_variants`, DM privado con botón postback (o texto si no hay botón), `public_replies` solo si la palabra clave es real (no comodín).
- **Palabras clave**: modos `contains` y `exact`; normalización sin tildes; varias palabras separadas por coma. En comentarios, `exact` admite la palabra dentro de una frase (palabra entera). En DMs sueltos, `exact` exige que el mensaje sea la palabra (o casi).
- **Comodines**: palabra clave de 1 letra o solo emoji responde por DM, sin respuesta pública automática.
- **Destinos de regla**: post concreto (gana a la global), global, `NEXT` (primer post posterior a la fecha de creación, comprobado con `timestamp` de la API), `STORIES` y `STORY:<id>` para respuestas a historias.
- **Historias**: respuesta a historia con match anclado; opción «también en historias» crea una regla gemela `STORIES` (`twin_de`).
- **DM con palabra clave** (sin comentario): se atiende como si se pulsara el botón de la regla.
- **Palabras escritas en vez de pulsar**: «Si quiero», «sí», etc. se tratan como el botón (solo si la persona tiene una entrega reciente de esa regla).
- **Seguir la cuenta** (`require_follow`): mensaje «Ver perfil» + «¡Ya te sigo!»; a la 3.ª pulsación se entrega aunque Meta diga que no sigue (el campo `is_user_follow_business` es poco fiable).
- **Captura de email** (`ask_email`): pedido con `email_prompt`; corrección de erratas de dominio (.con, gmai.com…); rechazo de emails «basura» (solo números antes de la @); hasta 2 reintentos si parece un intento; ventana de 6 h; si la persona ya dejó un email antes, no se le vuelve a pedir.
- **Entrega**: imagen y audio adjuntos, botones de enlace (hasta 3) con fallback a texto; `ig_entregas` evita entregar dos veces; `reentregable` permite reenvío tras 10 min desde el último clic.
- **Silencio humano**: si alguien ha contestado a mano en las últimas 24 h, el bot calla (eco `is_echo`).
- **Repetición**: el mismo usuario no recibe dos veces la misma regla en 24 h (`resent` / `duplicate`).
- **Tope por hora** (`RATE_LIMIT_PER_HOUR`, por defecto 200).
- **Error 2534025** (mensajes cerrados a no seguidores): se deja un comentario público pidiendo que siga la cuenta, una vez.
- **FAQs**: por palabras clave (contains) y por menú de postbacks (máx. 4, sincronizado con `messenger_profile`). Registro de aciertos en `ig_faq_hits`.
- **ig-click (v5)**: solo redirige a URLs que están en los botones de la regla; 404 en otro caso; no cuenta bots de previsualización.
- **ig-link-stats**: desglose de clics por botón, con usuario y email si lo dejó.
- **ig-admin**: `whoami`, `upload_media`, `ai_copy`, `list_accounts`, `set_mailerlite_key`, `mailerlite_groups`, `list_rules`, `rule_stats`, `upsert_rule`, `toggle_rule`, `delete_rule`, `list_faqs`, `upsert_faq`, `toggle_faq`, `delete_faq`, `faq_menu_sync`, `list_events`, `list_contacts`, `metrics`, `list_media`, `list_stories`.
- **OAuth**: canje corto → largo; si Meta aún no reconoce el token, se guarda uno provisional y se repara en segundo plano (5/10/20/30 s); IDs leídos como texto (precisión).
- **ig-refresh**: renueva tokens de cuentas con más de 30 días sin refrescar.
- **Textos legales** (`privacy`, `data-deletion`): mismo esquema, ahora configurable por variables.

## 2. Seguridad

- La firma `X-Hub-Signature-256` de Meta es obligatoria: lo que no viene firmado con `INSTAGRAM_APP_SECRET` recibe un 403.
- `ig-admin` e `ig-link-stats` solo responden con la cabecera `x-admin-password` (comparación en tiempo constante). CORS limitado a `PANEL_ORIGIN`.
- El panel guarda la contraseña en `sessionStorage`: se borra al cerrar la pestaña.
- El cron de `ig-refresh` se autentica con la cabecera `x-cron-secret`, nunca en la URL.
- Todas las tablas tienen RLS activo y **ninguna política**: `anon` y `authenticated` no leen nada; solo las funciones (service role). Los tokens de Instagram viven en `ig_accounts` y solo el servidor los ve.
- `ig-click` solo redirige a URLs que están en los botones de la regla: no sirve como redirección abierta.
- Ninguna clave está escrita en el código: todo sale de variables de entorno (`.env.example`).

## 3. Integraciones opcionales

Si falta la variable, ese paso se salta con un aviso en el log y lo demás sigue funcionando.

- **Resend** (`RESEND_API_KEY`, `EMAIL_FROM`): bienvenida genérica al primer email de cada dirección; avisos de fallo de conexión a `ALERT_EMAIL`.
- **Webhook de emails** (`EMAIL_WEBHOOK_URL`): cada email capturado se manda por POST en JSON.
- **MailerLite**: se configura por cuenta desde el panel.
- **Anthropic** (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`): el botón de IA que propone textos en el panel.

## 4. Lo que queda en el panel pero no se usa

- Los selectores de «cuenta» en el editor de automatizaciones y en el de FAQs (`rule_account`, `fqCuenta`) y las etiquetas «📷 @cuenta» solo aparecen si `CUENTAS.length > 1`. Con una cuenta no se ven. Se han dejado para no tocar el editor; se pueden borrar sin riesgo.
- La función `loadAccounts` mantiene la rama de varias cuentas, inerte con una sola.

## 5. Lo que está probado y lo que no

Probado en un proyecto de Supabase vacío: la migración se aplica limpia; verificación GET del webhook; firma (sin firma o con firma falsa → 403, firma buena → 200); un comentario «quiero la GUÍA» casa con la regla `guia`; si el envío a Meta falla, se registra el error sin caerse; `ig-admin` e `ig-link-stats` rechazan sin contraseña; `ig-click` solo redirige a los botones de la regla; `ig-refresh` exige `x-cron-secret`; la clave anon no puede leer ninguna tabla; el panel entra, lista y crea reglas en escritorio y en móvil.

Sin probar (hace falta una app de Meta real): el envío real del privado, el canje OAuth, la renovación real del token, y los flujos de email con Resend, MailerLite o el webhook de emails.
