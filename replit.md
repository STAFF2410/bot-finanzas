# Bot financiero de Telegram

Proyecto Node.js que usa Telegram, Gemini y Supabase, con la estructura y los
servicios originales.

## Pruebas

Ejecutar `npm test` (Node.js 20). Las 20 pruebas simulan Telegram, Gemini y
Supabase; no requieren claves, red ni datos reales. Cubren mensajes, audio,
saldos, guardado, errores y rechazo de otros usuarios y grupos.

Las pruebas simuladas no confirman la calidad de Gemini ni crean operaciones
reales. Para probar en vivo, enviar al bot un mensaje privado desde la cuenta
permitida. `/saldos` consulta saldos sin escribir. `/previsualizar <texto>` llama
a Gemini y muestra su análisis sin guardar, por lo que sirve para probarlo.
Los mensajes normales que Gemini considere completos sí guardan operaciones
permanentemente en la base configurada.

## Conexión y ejecución

El workflow `Telegram Finance Bot` ejecuta `npm start` y atiende el health check
en el puerto 3000. Requiere estos valores configurados en Replit Secrets:

- `TELEGRAM_BOT_TOKEN`
- `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `ALLOWED_TELEGRAM_USER_ID` (ID numérico; solo ese usuario en chat privado)

Supabase debe tener `cuentas`, `transacciones` y `vista_saldos_actuales`
compatibles con las consultas de `index.js`. El proyecto incluye `ws` como
transporte de Realtime para Supabase en Node.js 20; el bot no habilita ni utiliza
suscripciones Realtime.

El bot usa el modelo estable `gemini-3.5-flash` para texto y audio. `/start`
muestra los comandos disponibles.
