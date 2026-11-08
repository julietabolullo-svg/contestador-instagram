// Contestador de Instagram · política de privacidad (texto plano).
// Los datos del responsable se leen de variables de entorno: ver .env.example.
// Sirve esta URL en la configuración de la app de Meta como «Política de privacidad».

const RESPONSABLE = Deno.env.get("LEGAL_CONTROLLER_NAME") || "[NOMBRE DEL RESPONSABLE]";
const CONTACTO = Deno.env.get("LEGAL_CONTACT_EMAIL") || "[EMAIL DE CONTACTO]";
const APP = Deno.env.get("LEGAL_APP_NAME") || "Contestador de Instagram";
const FECHA = Deno.env.get("LEGAL_UPDATED_AT") || "[FECHA DE ÚLTIMA ACTUALIZACIÓN]";

const TEXT = `POLÍTICA DE PRIVACIDAD — ${APP}
Última actualización: ${FECHA}

Esta política describe cómo la aplicación "${APP}" (la App), gestionada por ${RESPONSABLE}, trata la información al automatizar respuestas por mensaje directo en Instagram.

1. RESPONSABLE DEL TRATAMIENTO
${RESPONSABLE}
Contacto: ${CONTACTO}

2. QUÉ DATOS TRATAMOS
Cuando una persona comenta en una publicación de la cuenta de Instagram conectada a la App, tratamos únicamente:
  • El identificador y el texto del comentario.
  • El identificador y el nombre de usuario público de quien comenta.
  • El identificador de la publicación.
Si la persona deja voluntariamente su correo electrónico en una conversación, lo guardamos también.
No recogemos contraseñas, ni datos de pago, ni información sensible.

3. PARA QUÉ LOS USAMOS
Con esos datos, la App envía automáticamente una respuesta por mensaje directo cuando el comentario coincide con una palabra clave configurada por el titular de la cuenta. También guardamos un registro de los envíos para evitar mensajes duplicados y para diagnóstico técnico.

4. BASE LEGAL
El tratamiento se basa en el interés legítimo del titular de la cuenta de Instagram de responder a las personas que interactúan con su contenido, conforme al Reglamento (UE) 2016/679 (RGPD).

5. CONSERVACIÓN Y TERCEROS
Los datos se almacenan en la infraestructura del proveedor de base de datos elegido por el responsable durante el tiempo necesario para prestar el servicio. No se venden ni se ceden a terceros con fines comerciales. Los datos se procesan a través de la API oficial de Meta/Instagram, sujeta a sus propias políticas.

6. TUS DERECHOS
Puedes ejercer tus derechos de acceso, rectificación, supresión, oposición y limitación escribiendo a ${CONTACTO}.

7. ELIMINACIÓN DE DATOS
Para solicitar la eliminación de tus datos, escribe a ${CONTACTO} indicando tu nombre de usuario de Instagram. Atenderemos la solicitud en un plazo máximo de 30 días.

8. CAMBIOS
Podremos actualizar esta política. La versión vigente estará siempre disponible en esta misma dirección.

© ${RESPONSABLE}`;

Deno.serve(() => new Response(TEXT, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));
