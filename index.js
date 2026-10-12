require('dotenv').config();
const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const { Bot: TelegramBot } = require('node-telegram-bot-api');
const { run: runTelegramBot } = require('node-telegram-bot-api/node');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// Validar variables de entorno requeridas
const requiredEnv = [
    'TELEGRAM_BOT_TOKEN',
    'GEMINI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'ALLOWED_TELEGRAM_USER_ID',
];
for (const envVar of requiredEnv) {
    if (!process.env[envVar]) {
        console.error(`❌ Error: La variable de entorno ${envVar} no está configurada.`);
        process.exit(1);
    }
}
if (!/^\d+$/.test(process.env.ALLOWED_TELEGRAM_USER_ID.trim())) {
    console.error('❌ Error: ALLOWED_TELEGRAM_USER_ID debe ser el ID numérico de Telegram.');
    process.exit(1);
}

// 1. INICIALIZACIÓN DE CLIENTES
console.log("Cargando constructor de Telegram...");
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: WebSocket },
});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function sendMessage(chatId, text, options) {
  return bot.api.sendMessage({ chat_id: chatId, text, ...options });
}

function sendChatAction(chatId, action) {
  return bot.api.sendChatAction({ chat_id: chatId, action });
}

async function getFileLink(fileId) {
  const file = await bot.api.getFile({ file_id: fileId });
  if (!file.file_path) throw new Error('Telegram no devolvió la ruta del audio.');
  return `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}

// 2. SERVIDOR EXPRESS (Monitoreo y Health-Check local)
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

function usuarioAutorizado(msg) {
  return msg.chat?.type === 'private'
    && String(msg.from?.id || '') === process.env.ALLOWED_TELEGRAM_USER_ID.trim();
}

async function rechazarAccesoNoAutorizado(chatId) {
  await sendMessage(chatId, '⛔ Este bot es privado y no tienes acceso autorizado.');
}

app.get('/', (req, res) => {
  res.send('🤖 Bot Financiero activo y escuchando eventos.');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Express escuchando en http://localhost:${PORT}`);
});

// 3. PROMPT DEL SISTEMA PARA GEMINI
const SYSTEM_PROMPT = `
Eres un Contador y Auditor Financiero Personal Estricto e Inflexible.
Tu trabajo es procesar mensajes en lenguaje natural sobre finanzas y convertirlos en un JSON estructurado para una base de datos contable.

PLATAFORMAS Y CUENTAS VÁLIDAS ÚNICAS:
- Bancolombia (Moneda típica: COP)
- BNC (Moneda típica: VES o USD)
- Binance P2P (Moneda típica: USDT)
- Zinli (Moneda típica: USD)
- Facebank (Moneda típica: USD)
- Wise (Moneda típica: USD)
- Towerbank (Moneda típica: USD)

MONEDAS VÁLIDAS: USDT, VES, COP, USD.

REGLAS DE AUDITORÍA Y VALIDACIÓN (FILTRO ESTRICTO):
1. PRINCIPIO DE PARTIDA DOBLE Y PRECISIÓN:
   - Cada movimiento debe tener origen, destino (si aplica), monto exacto y moneda definidos sin ninguna ambigüedad.
   - Si el usuario dice que sacó dinero de varias cuentas pero NO especifica cuánto salió de cada una, el estado es "incompleto".
   - Si los montos gastados no cuadran con los montos retirados o si quedan saldos flotantes no explicados, el estado es "incompleto".
   - Si hay una operación de intercambio/conversión (ej. de COP a VES o a USDT), DEBE identificarse claramente la cuenta origen, cuenta destino, monto entregado y monto recibido (o la tasa aplicada).
2. CATEGORIZACIÓN DINÁMICA:
   - Asigna una categoría lógica al gasto/ingreso según el contexto (ej. repuestos Benelli RK6 -> "Moto", almuerzo -> "Alimentación").
3. MODOS DE RESPUESTA:
   - Si falta algún dato o hay inconsistencia matemática:
     "estado": "incompleto", y en "mensaje_usuario" formula una pregunta concisa pidiendo el dato exacto faltante.
   - Si todo cuadra al 100%:
     "estado": "completo", desglosa cada operación atómica en "operaciones" y escribe un resumen en "mensaje_usuario".

ESTRUCTURA JSON OBLIGATORIA:
{
  "estado": "completo" | "incompleto",
  "motivo": "Explicación breve de la auditoría",
  "mensaje_usuario": "Mensaje para enviar al usuario por Telegram",
  "operaciones": [
    {
      "tipo": "gasto" | "ingreso" | "transferencia" | "intercambio",
      "cuenta_origen": "Nombre exacto de la cuenta",
      "cuenta_destino": null,
      "monto_origen": 0.00,
      "moneda_origen": "USDT",
      "monto_destino": null,
      "moneda_destino": null,
      "tasa_cambio": null,
      "categoria": "Moto",
      "descripcion": "Descripción del movimiento"
    }
  ]
}
`;

// Modelo de Gemini configurado para devolver JSON directamente
const geminiModel = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.1,
  },
  systemInstruction: SYSTEM_PROMPT,
});

// Cache local de cuentas registradas en Supabase
let cuentasCache = {};

async function cargarCuentas() {
  try {
    const { data, error } = await supabase.from('cuentas').select('id, nombre');
    if (error) throw error;
    cuentasCache = {};
    data.forEach((c) => {
      cuentasCache[c.nombre.toLowerCase().trim()] = c.id;
    });
    console.log(`✅ Cuentas sincronizadas desde Supabase (${data.length} encontradas).`);
  } catch (err) {
    console.error('❌ Error al cargar cuentas desde Supabase:', err.message);
  }
}
cargarCuentas();

// 4. FUNCIÓN PARA PROCESAR EL ANÁLISIS DE GEMINI
async function analizarConGemini(promptParts) {
  const result = await geminiModel.generateContent(promptParts);
  const responseText = result.response.text();
  return JSON.parse(responseText);
}

// 5. REGISTRAR OPERACIONES EN SUPABASE
async function registrarOperacionesEnSupabase(operaciones, rawText) {
  const registros = [];

  for (const op of operaciones) {
    const origenKey = op.cuenta_origen ? op.cuenta_origen.toLowerCase().trim() : null;
    const destinoKey = op.cuenta_destino ? op.cuenta_destino.toLowerCase().trim() : null;

    const origenId = origenKey ? cuentasCache[origenKey] : null;
    const destinoId = destinoKey ? cuentasCache[destinoKey] : null;

    if (!origenId) {
      throw new Error(`La cuenta origen "${op.cuenta_origen}" no existe en la base de datos.`);
    }

    if (op.cuenta_destino && !destinoId) {
      throw new Error(`La cuenta destino "${op.cuenta_destino}" no existe en la base de datos.`);
    }

    registros.push({
      tipo: op.tipo,
      cuenta_origen_id: origenId,
      cuenta_destino_id: destinoId,
      monto_origen: op.monto_origen,
      moneda_origen: op.moneda_origen,
      monto_destino: op.monto_destino || null,
      moneda_destino: op.moneda_destino || null,
      tasa_cambio: op.tasa_cambio || null,
      categoria: op.categoria || 'Varios',
      descripcion: op.descripcion || '',
      raw_prompt: rawText,
    });
  }

  const { error } = await supabase.from('transacciones').insert(registros);
  if (error) throw error;
  return registros.length;
}

// 6. PROCESAMIENTO CENTRAL DE MENSAJES (Texto o Voz)
async function procesarEntradaFinanciera(chatId, promptParts, rawTextPreview) {
  await sendChatAction(chatId, 'typing');

  try {
    const resultado = await analizarConGemini(promptParts);

    if (resultado.estado === 'incompleto') {
      // Contador estricto detectó inconsistencia o faltantes
      await sendMessage(chatId, `⚠️ *Información Incompleta*\n\n${resultado.mensaje_usuario}`,
        { parse_mode: 'Markdown' });
      return;
    }

    if (resultado.estado === 'completo') {
      if (!resultado.operaciones || resultado.operaciones.length === 0) {
        await sendMessage(chatId, '⚠️ No se detectaron operaciones para guardar.');
        return;
      }

      await registrarOperacionesEnSupabase(resultado.operaciones, rawTextPreview);

      // Confirmación exitosa con detalle
      let mensajeExito = `✅ *Operaciones Registradas Exitosamente:*\n\n`;
      resultado.operaciones.forEach((op, index) => {
        mensajeExito += `*${index + 1}. ${op.tipo.toUpperCase()}* - ${op.categoria}\n`;
        mensajeExito += `• Origen: ${op.cuenta_origen} (${op.monto_origen} ${op.moneda_origen})\n`;
        if (op.cuenta_destino) {
          mensajeExito += `• Destino: ${op.cuenta_destino} (${op.monto_destino} ${op.moneda_destino})\n`;
        }
        if (op.tasa_cambio) {
          mensajeExito += `• Tasa: ${op.tasa_cambio}\n`;
        }
        mensajeExito += `• Detalle: ${op.descripcion}\n\n`;
      });

      mensajeExito += `_${resultado.mensaje_usuario}_`;

      await sendMessage(chatId, mensajeExito, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('❌ Error procesando solicitud:', error);
    await sendMessage(chatId, `❌ *Error Contable/Servidor:* ${error.message}`,
      { parse_mode: 'Markdown' });
  }
}

// 7. PROCESAMIENTO DE MENSAJES DE TEXTO
async function procesarMensajeTexto(msg) {
  const chatId = msg.chat.id;
  if (!usuarioAutorizado(msg)) {
    await rechazarAccesoNoAutorizado(chatId);
    return;
  }
  const texto = msg.text.trim();

  if (/^\/(?:start|help)(?:@\w+)?(?:\s.*)?$/i.test(texto)) {
    await sendMessage(
      chatId,
      '🤖 Bot financiero conectado.\n\n'
      + '• /saldos — consulta saldos (solo lectura).\n'
      + '• /previsualizar <texto> — prueba Gemini sin guardar nada.\n'
      + '• Envía un movimiento normal solo cuando quieras registrarlo permanentemente.'
    );
    return;
  }

  // Vista previa segura para probar Gemini sin crear registros en Supabase.
  if (texto.startsWith('/previsualizar')) {
    const match = texto.match(/^\/previsualizar(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    const entrada = match?.[1]?.trim();
    if (!entrada) {
      await sendMessage(chatId, 'Uso: /previsualizar describe aquí el movimiento que quieres analizar.');
      return;
    }

    try {
      await sendChatAction(chatId, 'typing');
      const resultado = await analizarConGemini([entrada]);
      const detalle = JSON.stringify(resultado, null, 2) || String(resultado);
      const limite = 3600;
      const respuesta = `🧪 Vista previa Gemini — no se guardó en Supabase.\n\n${
        detalle.length > limite ? `${detalle.slice(0, limite)}\n… (respuesta recortada)` : detalle
      }`;
      await sendMessage(chatId, respuesta);
    } catch (error) {
      console.error('❌ Error en vista previa Gemini:', error);
      await sendMessage(chatId, `❌ No se pudo completar la vista previa: ${error.message}`);
    }
    return;
  }

  // Comando especial para consultar saldos
  if (texto === '/saldos') {
    try {
      const { data, error } = await supabase.from('vista_saldos_actuales').select('*');
      if (error) throw error;

      let respuesta = `📊 *Saldos Actuales Consolidados:*\n\n`;
      data.forEach((fila) => {
        respuesta += `• *${fila.cuenta}*: ${fila.saldo_actual} ${fila.moneda}\n`;
      });
      await sendMessage(chatId, respuesta, { parse_mode: 'Markdown' });
    } catch (err) {
      await sendMessage(chatId, `❌ Error al consultar saldos: ${err.message}`);
    }
    return;
  }

  // Si no es un comando, procesar con Gemini
  await procesarEntradaFinanciera(chatId, [texto], texto);
}

// 8. PROCESAMIENTO DE NOTAS DE VOZ (Audio nativo multimodal en Gemini)
async function procesarNotaDeVoz(msg) {
  const chatId = msg.chat.id;
  if (!usuarioAutorizado(msg)) {
    await rechazarAccesoNoAutorizado(chatId);
    return;
  }

  try {
    await sendChatAction(chatId, 'record_voice');

    // Obtener enlace del audio de Telegram
    const fileLink = await getFileLink(msg.voice.file_id);
    const responseAudio = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(responseAudio.data);

    // Preparar el archivo de voz para Gemini en formato inlineData
    const audioPart = {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: 'audio/ogg',
      },
    };

    await procesarEntradaFinanciera(
      chatId,
      [audioPart, 'Analiza este audio y aplica estrictamente las reglas contables.'],
      '[Nota de voz enviada]'
    );
  } catch (err) {
    console.error('❌ Error procesando nota de voz:', err);
    await sendMessage(chatId, `❌ Error al procesar audio: ${err.message}`);
  }
}

// 9. MANEJO GLOBAL DE ERRORES DEL BOT
bot.on('message', async (ctx) => {
  const msg = ctx.message;
  if (!msg) return;
  if (typeof msg.text === 'string') return procesarMensajeTexto(msg);
  if (msg.voice) return procesarNotaDeVoz(msg);
});

bot.catch((error) => {
  console.error('⚠️ Error procesando actualización de Telegram:', error.message);
});

runTelegramBot(bot).catch((error) => {
  console.error('⚠️ Error de conexión con Telegram:', error.message);
  process.exitCode = 1;
});

console.log('🤖 Bot de Telegram inicializado y escuchando...');