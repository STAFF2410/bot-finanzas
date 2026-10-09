# Bot financiero de Telegram

Proyecto importado: Node.js, Telegram, Gemini y Supabase. Se mantiene la
estructura y los servicios originales.

## Pruebas locales

Ejecutar `npm test` (Node.js 20). Las pruebas ejecutan el código de `index.js`
con servicios simulados: no necesitan dependencias instaladas, claves, red ni
datos reales. Cubren texto, voz, saldos, registro de operaciones y errores.
No prueban la calidad de la interpretación de Gemini, la compatibilidad real
de los paquetes, la API de Telegram ni el esquema/permisos de Supabase.

## Uso real antes de publicar

El comando del bot es `npm start`, una vez instaladas las dependencias.
Requiere `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `SUPABASE_URL` y
`SUPABASE_KEY`, configuradas mediante Secrets, nunca en el código ni en el chat.
Supabase debe tener `cuentas`, `transacciones` y `vista_saldos_actuales`
compatibles con las consultas de `index.js`.

Antes de activarlo, utilizar un bot y una base de datos separados para pruebas.
El código actual escribe directamente en Supabase: no tiene modo de simulación.
También carece de restricción de usuarios de Telegram; no conectarlo a datos
financieros reales sin resolver ese riesgo.

No hay un workflow de ejecución configurado ni se ha publicado el bot.
La conexión real a los tres servicios sigue pendiente.
