'use strict';

// M9-D430 — sandbox determinístico: os 10 cenários, idempotência com um único registro, capabilities coerentes, revogação, o registro com mode
// e o vínculo com o framework de Integrações. Sem banco.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const adapters = require('../../../src/features/marketing/publications/adapters');
const env = require('../_helpers/mktChannelEnv');

const { CHANNELS, CHANNEL_META, SCENARIOS, channelRegistry, resetSandbox, assertChannelAdapter } = adapters;
beforeEach(() => resetSandbox());
const CH = 'INSTAGRAM';
const run = (scenario, key, channel = CH, extra = {}) => env.sandboxFor(channel, extra)[env.operationOf(channel)](env.payload(), { idempotencyKey: key, scenario });

test('os_dez_cenarios_existem_e_cada_um_responde_como_o_livro_manda', async () => {
  assert.deepEqual([...SCENARIOS], ['OK', 'TIMEOUT', 'UNKNOWN_BUT_PUBLISHED', 'UNKNOWN_NOT_PUBLISHED', 'HTTP_429', 'HTTP_5XX', 'AUTH_REVOKED', 'REJECTED', 'DUPLICATE_KEY', 'SLOW']);
  const ok = await run('OK', 'k-ok-000001');
  assert.deepEqual([ok.status, ok.unknown, ok.error], ['PUBLISHED', false, null]);
  assert.match(ok.providerRef, /^sbx-instagram-[0-9a-f]{16}$/);

  const pub = await run('UNKNOWN_BUT_PUBLISHED', 'k-unk-pub-01');
  assert.deepEqual([pub.status, pub.unknown], ['UNKNOWN', true]);
  assert.equal((await env.sandboxFor(CH).findByIdempotencyKey('k-unk-pub-01')).found, true, 'foi publicado de fato');
  const naoPub = await run('UNKNOWN_NOT_PUBLISHED', 'k-unk-no-001');
  assert.deepEqual([naoPub.status, naoPub.unknown], ['UNKNOWN', true]);
  assert.equal((await env.sandboxFor(CH).findByIdempotencyKey('k-unk-no-001')).found, false, 'não foi publicado');

  const r429 = await run('HTTP_429', 'k-429-000001');
  assert.deepEqual([r429.status, r429.error.class, r429.error.httpStatus], ['FAILED', 'RATE_LIMIT', 429]);
  const r5 = await run('HTTP_5XX', 'k-5xx-000001');
  assert.deepEqual([r5.status, r5.error.class, r5.error.httpStatus], ['FAILED', 'TRANSIENT', 503]);
  const rej = await run('REJECTED', 'k-rej-000001');
  assert.deepEqual([rej.status, rej.error.class, rej.error.httpStatus], ['REJECTED', 'VALIDATION', 422]);
  for (const r of [r429, r5, rej]) assert.equal((await env.sandboxFor(CH).findByIdempotencyKey(r.idempotencyKey)).found, false, 'falha não grava');

  const auth = await run('AUTH_REVOKED', 'k-auth-00001');
  assert.deepEqual([auth.status, auth.error.class, auth.error.httpStatus], ['FAILED', 'AUTH', 401]);
  assert.equal((await env.sandboxFor(CH).healthCheck()).ok, false, 'a credencial revogada derruba a saúde');
  assert.equal((await run('OK', 'k-depois-0001')).error.class, 'AUTH', 'revogada, tudo recusa');
});

test('mesma_chave_2x_devolve_a_mesma_resposta_com_um_unico_registro', async () => {
  const a = await run(undefined, 'k-idem-000001');
  const b = await run(undefined, 'k-idem-000001');
  assert.equal(b.providerRef, a.providerRef);
  assert.equal(b.status, a.status);
  assert.equal(b.replayed, true);
  assert.equal(adapters.sandboxRecordCount('qa-m9', CH), 1);
  const dup = await run('DUPLICATE_KEY', 'k-dup-0000001');
  assert.equal(dup.duplicate, true);
  assert.equal(dup.error.code, 'DUPLICATE_KEY');
  assert.equal(dup.providerRef, (await env.sandboxFor(CH).findByIdempotencyKey('k-dup-0000001')).providerRef);
  assert.equal(adapters.sandboxRecordCount('qa-m9', CH), 2);
  const unk = await run('UNKNOWN_BUT_PUBLISHED', 'k-reenvio-0001');
  const reenviado = await run(undefined, 'k-reenvio-0001');
  assert.equal(reenviado.status, 'PUBLISHED', 'repetir depois do UNKNOWN é seguro: devolve o que já foi publicado');
  assert.equal(reenviado.providerRef, (await env.sandboxFor(CH).findByIdempotencyKey('k-reenvio-0001')).providerRef);
  assert.equal(unk.unknown, true);
  assert.equal(adapters.sandboxRecordCount('qa-m9', CH), 3);
});

test('slow_espera_o_tempo_do_parametro_e_depois_responde_ok', async () => {
  const esperas = [];
  const r = await run('SLOW', 'k-slow-000001', 'WHATSAPP', { slowMs: 1234, sleep: async (ms) => { esperas.push(ms); } });
  assert.deepEqual(esperas, [1234]);
  assert.equal(r.status, 'SENT');
});

test('http_429_respeita_o_backoff_do_parametro', async () => {
  const r = await run('HTTP_429', 'k-429-backoff1', CH, { retryAfterS: 41 });
  assert.equal(r.error.retryAfterMs, 41000);
  assert.deepEqual(env.sandboxFor(CH).classifyError({ status: 429, retryAfterMs: 41000 }), { class: 'RATE_LIMIT', code: 'HTTP_429', retryAfterMs: 41000 });
});

test('chave_de_idempotencia_e_obrigatoria_e_cenario_desconhecido_e_recusado', async () => {
  const a = env.sandboxFor(CH);
  await assert.rejects(() => a.publish(env.payload(), {}), (e) => e.statusCode === 422 && e.code === 'MKT_VALIDATION');
  await assert.rejects(() => a.publish(env.payload(), { idempotencyKey: 'k-cen-000001', scenario: 'NAO_EXISTE' }), (e) => e.code === 'MKT_VALIDATION');
  await assert.rejects(() => a.publish(null, { idempotencyKey: 'k-cen-000002' }), (e) => e.code === 'MKT_VALIDATION');
});

test('cenario_tambem_vem_por_cabecalho_de_teste', async () => {
  const r = await env.sandboxFor(CH).publish(env.payload(), { idempotencyKey: 'k-hdr-0000001', headers: { 'x-mkt-sandbox-scenario': 'REJECTED' } });
  assert.equal(r.status, 'REJECTED');
});

test('capabilities_coerentes: o declarado funciona e o não declarado é recusado', async () => {
  for (const channel of CHANNELS) {
    const a = env.sandboxFor(channel);
    const caps = a.capabilities();
    const meta = CHANNEL_META[channel];
    assert.ok(caps.includes(meta.operation) && !caps.includes(meta.operation === 'send' ? 'publish' : 'send'), channel);
    assert.equal(caps.includes('getMetrics'), meta.metrics.length > 0, `${channel}: getMetrics só onde há métrica`);
    assert.deepEqual(assertChannelAdapter(a), { ok: true, problems: [] });
    const outra = meta.operation === 'send' ? 'publish' : 'send';
    await assert.rejects(() => a[outra](env.payload(), { idempotencyKey: 'k-cap-00000001' }), (e) => e.statusCode === 422 && e.code === 'MKT_CHANNEL_OPERATION_UNSUPPORTED');
    const r = await a[meta.operation](env.payload(), { idempotencyKey: 'k-cap-00000002' });
    assert.equal((await a.getStatus(r.providerRef)).found, true);
    if (meta.metrics.length) assert.deepEqual(Object.keys((await a.getMetrics(r.providerRef)).metrics), meta.metrics);
    else await assert.rejects(() => a.getMetrics(r.providerRef), (e) => e.code === 'MKT_CHANNEL_OPERATION_UNSUPPORTED');
  }
});

test('assertChannelAdapter_reprova_adapter_incompleto', () => {
  const r = assertChannelAdapter({ capabilities: () => ['send'], healthCheck: async () => ({}) });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('findByIdempotencyKey')) && r.problems.some((p) => p.includes('send')));
});

test('revoke_derruba_a_credencial_e_a_saude', async () => {
  const a = env.sandboxFor(CH);
  assert.equal((await a.healthCheck()).ok, true);
  assert.deepEqual(await a.revoke({ id: 'c-1' }), { revoked: true, sandbox: true });
  assert.equal((await env.sandboxFor(CH).healthCheck()).ok, false);
});

test('registry_tem_os_9_canais_em_SANDBOX_e_em_PRODUCTION_e_nenhum_sem_mode', () => {
  const lista = channelRegistry.list();
  for (const channel of CHANNELS) {
    const modos = lista.filter((x) => x.channel === channel).map((x) => x.mode).sort();
    assert.deepEqual(modos, ['PRODUCTION', 'SANDBOX'], channel);
  }
  assert.ok(lista.every((x) => ['SANDBOX', 'PRODUCTION'].includes(x.mode)));
  assert.throws(() => channelRegistry.get('ORKUT', 'SANDBOX'), (e) => e.code === 'MKT_VALIDATION');
});

test('o_marketing_usa_o_framework_de_integracoes_e_nao_recria_o_registry', () => {
  const { AdapterRegistry } = require('../../../src/features/integrations');
  const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
  registerBuiltInAdapters();
  for (const channel of CHANNELS) {
    const m = CHANNEL_META[channel];
    assert.ok(AdapterRegistry.has(m.sandboxProvider), `${channel} apoia-se no sandbox ${m.sandboxProvider} do bloco B`);
  }
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../../../src/features/marketing/publications/adapters');
  const fontes = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!/class\s+\w*(Dispatch|CircuitBreaker|Outbox)/.test(fontes), 'sem reimplementar dispatch, circuit breaker nem outbox');
});
