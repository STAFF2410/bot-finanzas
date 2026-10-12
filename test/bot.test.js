const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the existing entry point unchanged, replacing only external services.
// No dependency installation, real environment variables, network or DB is used.
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const operation = (overrides = {}) => ({
  tipo: 'gasto', cuenta_origen: 'Zinli', cuenta_destino: null,
  monto_origen: 12, moneda_origen: 'USD', monto_destino: null,
  moneda_destino: null, tasa_cambio: null, categoria: 'Alimentación',
  descripcion: 'Almuerzo', ...overrides,
});

async function setup(options = {}) {
  const state = { handlers: {}, messages: [], actions: [], inserts: [],
    prompts: [], downloads: [], logs: [], listening: false };
  const analysis = options.analysis ?? {
    estado: 'completo', operaciones: [operation()], mensaje_usuario: 'Registrado',
  };
  const bot = {
    on(event, handler) { state.handlers[event] = handler; return this; },
    catch(handler) { state.errorHandler = handler; return this; },
    api: {
      async sendMessage({ chat_id: chatId, text, ...formatting }) {
        state.messages.push({ chatId, text, formatting });
      },
      async sendChatAction({ action }) { state.actions.push(action); },
      async getFile() {
        if (options.voiceError) throw new Error('Audio no disponible');
        return { file_path: 'voice/file.ogg' };
      },
    },
  };
  const database = {
    from(table) {
      return {
        async select() {
          if (table === 'cuentas') return {
            data: [{ id: 1, nombre: 'Zinli' }, { id: 2, nombre: 'Wise' }],
            error: options.accountsError ? new Error('No se pudieron cargar cuentas') : null,
          };
          assert.equal(table, 'vista_saldos_actuales');
          return { data: [{ cuenta: 'Zinli', saldo_actual: 100, moneda: 'USD' }],
            error: options.balanceError ? new Error('Consulta rechazada') : null };
        },
        async insert(rows) {
          assert.equal(table, 'transacciones');
          if (options.insertError) return { error: new Error('Inserción rechazada') };
          state.inserts.push(rows);
          return { error: null };
        },
      };
    },
  };
  const expressApp = {
    use() {}, get() {}, listen() { state.listening = true; },
  };
  const express = () => expressApp;
  express.json = () => () => {};
  const modules = {
    dotenv: { config() {} },
    express,
    axios: { async get(url) {
      state.downloads.push(url);
      return { data: Buffer.from('simulated audio') };
    } },
    ws: function TestWebSocket() {},
    'node-telegram-bot-api': function () { return bot; },
    'node-telegram-bot-api/node': { run() { state.polling = true; return Promise.resolve(); } },
    '@supabase/supabase-js': { createClient(url, key, options) {
      assert.equal(options.realtime.transport, modules.ws);
      return database;
    } },
    '@google/generative-ai': { GoogleGenerativeAI: class {
      getGenerativeModel() {
        return { async generateContent(parts) {
          state.prompts.push(parts);
          if (options.geminiError) throw new Error('Gemini no disponible');
          return { response: { text: () => options.rawResponse ?? JSON.stringify(analysis) } };
        } };
      }
    } },
  };
  const env = {
    TELEGRAM_BOT_TOKEN: 'fake-test-only', GEMINI_API_KEY: 'fake-test-only',
    SUPABASE_URL: 'https://example.invalid', SUPABASE_KEY: 'fake-test-only',
    ALLOWED_TELEGRAM_USER_ID: '123456789',
    ...options.env,
  };
  vm.runInNewContext(source, {
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      if (name === 'node-telegram-bot-api') return { Bot: modules[name] };
      return modules[name];
    },
    process: { env, exit(code) { throw new Error(`exit:${code}`); } },
    console: {
      log(...args) { state.logs.push(args); },
      error(...args) { state.logs.push(args); },
    },
    Buffer,
  }, { filename: 'index.js' });
  // Allow the initial asynchronous accounts load to finish.
  await new Promise(resolve => setImmediate(resolve));
  state.text = (text, overrides = {}) => state.handlers.message({ message: {
    chat: { id: 10, type: 'private' }, from: { id: 123456789 }, text, ...overrides,
  } });
  state.voice = (overrides = {}) => state.handlers.message({ message: {
    chat: { id: 10, type: 'private' }, from: { id: 123456789 },
    voice: { file_id: 'simulated-file' }, ...overrides,
  } });
  return state;
}

test('rechaza el inicio si falta una clave requerida', async () => {
  await assert.rejects(setup({ env: { TELEGRAM_BOT_TOKEN: undefined } }), /exit:1/);
});

test('rechaza un ID autorizado que no sea numérico', async () => {
  await assert.rejects(
    setup({ env: { ALLOWED_TELEGRAM_USER_ID: 'not-an-id' } }),
    /exit:1/,
  );
});

test('rechaza mensajes privados de otras personas antes de Gemini o Supabase', async () => {
  const s = await setup();
  await s.text('/saldos', { from: { id: 999999999 } });
  assert.equal(s.prompts.length, 0);
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /bot es privado/);
});

test('rechaza grupos aunque escriba el usuario autorizado', async () => {
  const s = await setup();
  await s.text('/saldos', { chat: { id: -10, type: 'group' } });
  assert.equal(s.prompts.length, 0);
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /bot es privado/);
});

test('rechaza notas de voz de otras personas sin descargarlas ni procesarlas', async () => {
  const s = await setup();
  await s.voice({ from: { id: 999999999 } });
  assert.equal(s.downloads.length, 0);
  assert.equal(s.prompts.length, 0);
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /bot es privado/);
});

test('registra un gasto y responde al mismo chat', async () => {
  const s = await setup();
  await s.text('Gasté 12 USD de Zinli en almuerzo');
  assert.equal(s.inserts.length, 1);
  assert.equal(s.inserts[0][0].cuenta_origen_id, 1);
  assert.equal(s.inserts[0][0].monto_origen, 12);
  assert.equal(s.inserts[0][0].raw_prompt, 'Gasté 12 USD de Zinli en almuerzo');
  assert.equal(s.messages[0].chatId, 10);
  assert.match(s.messages[0].text, /Registradas Exitosamente/);
});

test('pide datos faltantes sin guardar operaciones', async () => {
  const s = await setup({ analysis: {
    estado: 'incompleto', mensaje_usuario: '¿De qué cuenta salió?', operaciones: [],
  } });
  await s.text('Gasté 12');
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /¿De qué cuenta salió/);
});

test('no guarda una respuesta completa sin operaciones', async () => {
  const s = await setup({ analysis: { estado: 'completo', operaciones: [] } });
  await s.text('Hola');
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /No se detectaron operaciones/);
});

test('normaliza espacios y mayúsculas de las cuentas', async () => {
  const s = await setup({ analysis: {
    estado: 'completo', operaciones: [operation({ cuenta_origen: ' ZINLI ' })],
  } });
  await s.text('Gasto');
  assert.equal(s.inserts[0][0].cuenta_origen_id, 1);
});

test('registra ambos lados de un intercambio', async () => {
  const s = await setup({ analysis: {
    estado: 'completo', mensaje_usuario: 'Intercambio registrado',
    operaciones: [operation({ tipo: 'intercambio', cuenta_destino: 'Wise',
      monto_destino: 10, moneda_destino: 'USD', tasa_cambio: 12 / 10 })],
  } });
  await s.text('Intercambio');
  assert.equal(s.inserts[0][0].cuenta_destino_id, 2);
  assert.equal(s.inserts[0][0].monto_destino, 10);
  assert.match(s.messages[0].text, /Destino: Wise/);
});

for (const account of ['cuenta_origen', 'cuenta_destino']) {
  test(`rechaza ${account} desconocida sin guardar parcialmente`, async () => {
    const s = await setup({ analysis: {
      estado: 'completo', operaciones: [operation(), operation({ [account]: 'Desconocida' })],
    } });
    await s.text('Dos movimientos');
    assert.equal(s.inserts.length, 0);
    assert.match(s.messages[0].text, /no existe en la base de datos/);
  });
}

test('consulta saldos sin llamar a Gemini ni guardar datos', async () => {
  const s = await setup();
  await s.text('/saldos');
  assert.equal(s.prompts.length, 0);
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /100 USD/);
});

test('previsualiza el análisis de Gemini sin guardar operaciones', async () => {
  const s = await setup();
  await s.text('/previsualizar Gasté 12 USD de Zinli en almuerzo');
  assert.equal(s.prompts.length, 1);
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /no se guardó en Supabase/i);
  assert.match(s.messages[0].text, /Alimentación/);
});

test('admite la sintaxis de comando con nombre de bot sin guardar', async () => {
  const s = await setup();
  await s.text('/previsualizar@FinanzasBot Gasté 12 USD de Zinli en almuerzo');
  assert.equal(s.prompts.length, 1);
  assert.equal(s.inserts.length, 0);
});

test('pide un texto para la vista previa sin llamar a Gemini', async () => {
  const s = await setup();
  await s.text('/previsualizar');
  assert.equal(s.prompts.length, 0);
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /Uso: \/previsualizar/);
});

for (const [name, options, expected] of [
  ['fallo de Gemini', { geminiError: true }, /Gemini no disponible/],
  ['JSON inválido', { rawResponse: 'no es JSON' }, /Error Contable\/Servidor/],
  ['fallo al guardar', { insertError: true }, /Inserción rechazada/],
  ['fallo al cargar cuentas', { accountsError: true }, /no existe en la base de datos/],
  ['fallo al consultar saldos', { balanceError: true }, /Consulta rechazada/],
]) {
  test(`informa ${name} sin confirmar un registro exitoso`, async () => {
    const s = await setup(options);
    await s.text(options.balanceError ? '/saldos' : 'Gasto');
    assert.equal(s.inserts.length, 0);
    assert.match(s.messages[0].text, expected);
    assert.doesNotMatch(s.messages[0].text, /Registradas Exitosamente/);
  });
}

test('envía una nota de voz como audio a Gemini y registra su análisis', async () => {
  const s = await setup();
  await s.voice();
  assert.equal(s.downloads.length, 1);
  assert.equal(s.prompts[0][0].inlineData.mimeType, 'audio/ogg');
  assert.equal(s.prompts[0][0].inlineData.data, Buffer.from('simulated audio').toString('base64'));
  assert.equal(s.inserts[0][0].raw_prompt, '[Nota de voz enviada]');
});

test('informa un fallo descargando audio sin guardar movimientos', async () => {
  const s = await setup({ voiceError: true });
  await s.voice();
  assert.equal(s.prompts.length, 0);
  assert.equal(s.inserts.length, 0);
  assert.match(s.messages[0].text, /Error al procesar audio/);
});
