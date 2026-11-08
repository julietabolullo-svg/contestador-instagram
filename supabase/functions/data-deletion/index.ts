// Contestador de Instagram · instrucciones de eliminación de datos (texto plano).
// Los datos del responsable se leen de variables de entorno: ver .env.example.
// Sirve esta URL en la configuración de la app de Meta como «URL de eliminación de datos».

const RESPONSABLE = Deno.env.get("LEGAL_CONTROLLER_NAME") || "[NOMBRE DEL RESPONSABLE]";
const CONTACTO = Deno.env.get("LEGAL_CONTACT_EMAIL") || "[EMAIL DE CONTACTO]";
const APP = Deno.env.get("LEGAL_APP_NAME") || "Contestador de Instagram";

const TEXT = `ELIMINACIÓN DE DATOS — ${APP}

Puedes solicitar la eliminación de todos tus datos de esta aplicación en cualquier momento.

CÓMO SOLICITARLO
1. Envía un correo a ${CONTACTO} con el asunto "Eliminar mis datos".
2. Indica tu nombre de usuario de Instagram (@usuario).
3. Eliminaremos tu registro de comentarios, mensajes, email y cualquier dato asociado en un plazo máximo de 30 días, y te lo confirmaremos por correo.

QUÉ SE ELIMINA
• Identificadores de Instagram y nombre de usuario
• Textos de comentarios procesados
• Dirección de correo electrónico facilitada
• Historial de mensajes automáticos

Responsable: ${RESPONSABLE} · ${CONTACTO}`;

Deno.serve(() => new Response(TEXT, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));
