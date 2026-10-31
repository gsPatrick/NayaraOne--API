'use strict';

// M9-D430 — implementação REAL dos adapters (chamada HTTP pelo cliente único do bloco B, que usa o resilientFetch), com um cliente HTTP falso: sem rede.
// Prova o que sai na chamada (URL, idempotência, segredo só no cabeçalho), a classificação de erro, o UNKNOWN no timeout e a regra de nenhuma
// chamada a provedor real fora de canal liberado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adapters = require('../../../src/features/marketing/publications/adapters');
const env = require('../_helpers/mktChannelEnv');

const { CHANNELS, CHANNEL_META, RealChannelAdapter, mintReleaseProof } = adapters;
const SEGREDO = 'tok_live_AbCdEf0123456789SegredoDoCanal';

/** Resposta mínima no formato do fetch. */
const resposta = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, text: async () => JSON.stringify(body), json: async () => body,
});

function ctxFalso(handler) {
  const chamadas = [];
  return {
    chamadas,
    ctx: {
      connection: { id: 'conn-1', providerCode: 'x', environment: 'PRODUCTION', apiVersion: null, config: { baseUrl: 'https://gateway.exemplo.com.br/v1/' } },
      policy: {}, baseUrlHosts: ['gateway.exemplo.com.br'], timeouts: { readMs: 1000, writeMs: 1000 }, healthCheckTimeoutMs: 1000, // host da lista fechada da plataforma (M9-D244 R3-L5)
      http: { request: async (req) => { chamadas.push(req); return handler(req); } },
      secret: async () => ({ value: { reveal: () => SEGREDO } }),
    },
  };
}
const real = (channel, handler, opts = {}) => {
  const f = ctxFalso(handler);
  return { f, adapter: new RealChannelAdapter(channel, f.ctx, { proof: mintReleaseProof(), ...opts }) };
};

test('real_envia_com_chave_de_idempotencia_e_segredo_so_no_cabecalho', async () => {
  const { f, adapter } = real('WHATSAPP', () => resposta(201, { id: 'wamid-1', status: 'SENT' }));
  const r = await adapter.send(env.payload(), { idempotencyKey: 'chave-real-0001' });
  assert.deepEqual([r.status, r.providerRef, r.sandbox, r.mode], ['SENT', 'wamid-1', false, 'PRODUCTION']);
  const [c] = f.chamadas;
  assert.equal(c.method, 'POST');
  assert.equal(c.url, 'https://gateway.exemplo.com.br/v1/messages');
  assert.equal(c.headers['idempotency-key'], 'chave-real-0001');
  assert.equal(c.headers.authorization, `Bearer ${SEGREDO}`);
  assert.ok(!JSON.stringify(r).includes(SEGREDO) && !JSON.stringify(adapter.logEntries()).includes(SEGREDO));
});

test('real_so_aceita_base_https_e_cenario_de_teste_so_vale_no_sandbox', async () => {
  const { adapter } = real('EMAIL', () => resposta(200, {}));
  await assert.rejects(() => adapter.send(env.payload(), { idempotencyKey: 'chave-real-0002', scenario: 'OK' }), (e) => e.statusCode === 422 && e.code === 'MKT_VALIDATION');
  const f = ctxFalso(() => resposta(200, {}));
  f.ctx.connection.config.baseUrl = 'http://inseguro.exemplo.com.br';
  const inseguro = new RealChannelAdapter('EMAIL', f.ctx, { proof: mintReleaseProof() });
  await assert.rejects(() => inseguro.send(env.payload(), { idempotencyKey: 'chave-real-0003' }), (e) => e.code === 'MKT_VALIDATION');
  assert.equal(f.chamadas.length, 0, 'nada saiu');
});

test('real_classifica_429_com_retry_after_401_422_e_5xx_sem_levantar_excecao', async () => {
  const casos = [
    [429, { 'retry-after': '12' }, 'FAILED', 'RATE_LIMIT', 12000],
    [401, {}, 'FAILED', 'AUTH', undefined],
    [422, {}, 'REJECTED', 'VALIDATION', undefined],
    [503, {}, 'FAILED', 'TRANSIENT', undefined],
  ];
  for (const [code, headers, status, classe, retryAfterMs] of casos) {
    const { adapter } = real('INSTAGRAM', () => resposta(code, { erro: 'x' }, headers));
    const r = await adapter.publish(env.payload(), { idempotencyKey: `chave-real-${code}` });
    assert.deepEqual([r.status, r.error.class, r.error.httpStatus, r.error.retryAfterMs], [status, classe, code, retryAfterMs]);
    assert.equal(r.sandbox, false);
  }
});

test('real_timeout_vira_UNKNOWN_e_resposta_sem_id_tambem', async () => {
  const { adapter } = real('LINKEDIN', () => { throw Object.assign(new Error('Timeout'), { code: 'TIMEOUT' }); });
  const t = await adapter.publish(env.payload(), { idempotencyKey: 'chave-real-0010' });
  assert.deepEqual([t.status, t.unknown, t.error.code], ['UNKNOWN', true, 'TIMEOUT']);
  const { adapter: semId } = real('LINKEDIN', () => resposta(200, { ok: true }));
  const s = await semId.publish(env.payload(), { idempotencyKey: 'chave-real-0011' });
  assert.deepEqual([s.status, s.unknown], ['UNKNOWN', true]);
});

test('real_consulta_por_chave_status_metricas_e_saude', async () => {
  const { f, adapter } = real('PORTAL', (req) => {
    if (req.url.includes('idempotency_key')) return resposta(200, { items: [{ id: 'lst-9', status: 'PUBLISHED' }] });
    if (req.url.endsWith('/metrics')) return resposta(200, { views: 10, contacts: 2 });
    if (req.url.endsWith('/health')) return resposta(200, {});
    return resposta(200, { id: 'lst-9', status: 'PUBLISHED' });
  });
  assert.deepEqual(await adapter.findByIdempotencyKey('chave-real-0020'), { found: true, providerRef: 'lst-9', status: 'PUBLISHED', sandbox: false });
  assert.deepEqual((await adapter.getMetrics('lst-9')).metrics, { views: 10, contacts: 2 });
  assert.equal((await adapter.getStatus('lst-9')).status, 'PUBLISHED');
  assert.equal((await adapter.healthCheck()).ok, true);
  const quebrado = real('PORTAL', () => { throw new Error('rede'); }).adapter;
  assert.equal((await quebrado.healthCheck()).ok, false, 'healthCheck nunca lança');
  assert.equal(f.chamadas.every((c) => c.url.startsWith('https://gateway.exemplo.com.br/v1/')), true);
});

test('nenhuma_chamada_a_provedor_real_fora_de_canal_liberado: sem a prova da liberação o adapter real nem nasce', () => {
  for (const channel of CHANNELS) {
    assert.throws(() => new RealChannelAdapter(channel, ctxFalso(() => resposta(200, {})).ctx, {}), (e) => e.statusCode === 409 && e.code === 'MKT_CHANNEL_NOT_RELEASED' && e.message === 'Este canal ainda não foi liberado para produção.', channel);
    assert.throws(() => new RealChannelAdapter(channel, ctxFalso(() => resposta(200, {})).ctx, { proof: Symbol('falsa') }), (e) => e.code === 'MKT_CHANNEL_NOT_RELEASED');
  }
  assert.equal(CHANNEL_META.WHATSAPP.operation, 'send');
});

test('arquitetura: chamada HTTP e a prova da liberação só moram onde devem', () => {
  const raiz = path.join(__dirname, '../../../src/features/marketing');
  const arquivos = fs.readdirSync(raiz, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(raiz, f), 'utf8')]);
  const semComentario = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [f, t] of arquivos) {
    const code = semComentario(t);
    assert.ok(!/(?<![\w.$])fetch\s*\(|require\(['"]node:https?['"]\)|require\(['"]https?['"]\)|axios/.test(code), `${f}: HTTP direto`);
    assert.ok(!/resilientFetch/.test(code), `${f}: o resilientFetch é do cliente único do bloco B`);
    if (/mintReleaseProof\s*\(/.test(code) && !f.endsWith('releaseProof.js') && !f.endsWith('channelAccess.js')) assert.fail(`${f}: só a resolução do canal liberado emite a prova`);
  }
  assert.ok(arquivos.some(([f]) => f.endsWith('RealChannelAdapter.js')));
});
