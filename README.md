# Contestador de Instagram

Alguien comenta **GUÍA** en tu reel.

A los dos segundos le llega un privado con la guía.

Y tú estabas comiendo.

Eso es esto. Un contestador para tu cuenta de Instagram que vive en tu propio Supabase. Sin cuota mensual y sin depender de una herramienta de fuera.

Yo lo usaba con una herramienta de pago, hasta que me lo monté. Ahora lo regalo.

> Si lo de Meta se te hace bola, te lo montamos nosotros: [hola@laagenciadeia.com](mailto:hola@laagenciadeia.com?subject=Contestador%3A%20quiero%20que%20me%20lo%20mont%C3%A9is)

---

## Qué hace

- **Contesta al comentario** en público («¡Te lo mando por privado!»), con varias frases para que no parezca un robot.
- **Manda el privado** con botones: tu guía, tu web, tu tienda. Lo que quieras.
- **Le da igual cómo lo escriban.** «guia», «Guía», «GUÍA!!» valen lo mismo.
- **Puede pedir el email** antes de mandar el regalo, y guardarlo. Si usas Resend, le llega también un correo de bienvenida. Si usas otra herramienta para tu lista, se lo pasa por un webhook (Make, Zapier, la que tengas).
- **Puede pedir que te sigan** antes de mandarlo.
- **Una regla por publicación o para todas**: cada reel con su palabra y su regalo. También para el próximo reel que subas, y para las respuestas a tus historias.
- **Preguntas frecuentes**: si te escriben «precio» o «horario» por privado, contesta solo.
- **Se calla si contestas tú.** Si respondes a alguien a mano, el contestador no se mete en esa conversación durante 24 horas.
- **Un panel** para crear reglas, ver quién ha escrito y cuántos han pulsado cada botón.
- **Se renueva solo** el permiso de Instagram, que caduca cada 60 días.

## Para quién es

Es para ti si:

- Ya haces reels con «comenta la palabra y te lo mando».
- Pagas cada mes una herramienta solo para eso.
- Tienes Claude (Claude Code) o te apetece probarlo, porque es quien lo va a instalar.
- Es tu cuenta, o la de tu negocio.

No es para ti si:

- Llevas las cuentas de veinte clientes. Para cuentas de otros, Meta pide una revisión de la app que esto no cubre.
- Buscas un chatbot que conteste a todo. Esto contesta a palabras clave, y lo hace bien.

## Cómo se instala

No tienes que tocar código. Se lo das a tu Claude y te va guiando.

1. **Descárgate esto** (botón verde de arriba, *Code → Download ZIP*) y descomprímelo.
2. **Abre la carpeta con Claude Code** y escríbele:

   ```
   Instálame el contestador
   ```

3. Claude te irá pidiendo lo que necesita, paso a paso:
   - Una cuenta gratis en [Supabase](https://supabase.com) (aquí vive el contestador).
   - Tu cuenta de Instagram en modo **profesional** (empresa o creador).
   - Una cuenta de desarrollador en [Meta for Developers](https://developers.facebook.com), que es gratis.

### La parte de Meta

Aquí es donde se atasca casi todo el mundo: crear la app, dar los permisos, enchufar el aviso de comentarios. No es difícil, pero son muchas pantallas y Meta las cambia de sitio cada pocos meses.

Claude te va diciendo dónde pinchar. Pero si prefieres que lo hagamos nosotros y tú solo crear tus reglas, [escríbenos](mailto:hola@laagenciadeia.com?subject=Contestador%3A%20quiero%20que%20me%20lo%20mont%C3%A9is) y te lo dejamos funcionando.

4. **Conecta tu cuenta** desde el panel, crea tu primera regla y pruébala comentando desde otra cuenta.

Una vez está montado, no hay que volver a tocarlo.

## Lo que me ha dado guerra (para que a ti no)

Al principio fallaba en dos sitios: el permiso de Instagram caducaba a los 60 días sin avisar, y la gente escribía la palabra con tildes, mayúsculas o un emoji detrás. Las dos cosas están resueltas: el permiso se renueva solo y la palabra se reconoce la escriban como la escriban.

Si un día deja de contestar, el apartado *Si algo falla* de [`CLAUDE.md`](CLAUDE.md) dice dónde mirar. Tu Claude lo sabe leer.

## Lo que cuesta

- **Supabase:** el plan gratis va sobrado para una cuenta.
- **Meta:** gratis.
- **Resend** (opcional, para el correo de bienvenida): gratis hasta 3.000 correos al mes.
- **El texto con IA del panel** (opcional): unos céntimos si le pones una clave de Anthropic.

## Por dentro, para quien quiera mirarlo

- `supabase/functions/` las funciones: el webhook que recibe los comentarios, el panel, la conexión con Instagram y la renovación del permiso.
- `supabase/migrations/` las tablas.
- `panel/` el panel, una sola página HTML.
- [`NOTAS-TECNICAS.md`](NOTAS-TECNICAS.md) los detalles.

Cada aviso que llega de Meta se comprueba con la firma de tu app; lo que no viene firmado, se descarta.

## ¿Te lo montamos?

Si quieres usarlo y no quieres pelearte con Meta, te lo montamos en tu cuenta y te enseñamos a crear reglas.

[hola@laagenciadeia.com](mailto:hola@laagenciadeia.com?subject=Contestador%3A%20quiero%20que%20me%20lo%20mont%C3%A9is)

---

Licencia MIT: úsalo, cámbialo, móntaselo a quien quieras.
