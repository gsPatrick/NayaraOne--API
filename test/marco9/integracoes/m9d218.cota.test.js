'use strict';

// Marco 9, M9-D218 — cota do fornecedor: extração dos cabeçalhos, reserva para operação essencial, 429, cota zerada, alerta e saúde.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, tentativas, erros, instalar, restaurar, ler, dispatch, config, limparConfig, forcar,
} = require('../_helpers/m9d214Env');
const { mensagemProgramavel, erroHttp } = require('../_helpers/m9d214Scripted');
const health = require('../../../src/features/integrations/health');
const { IntegrationConnection } = require('../../../src/models');

let tenant;
let msg;
let Msg;
const ctx = () => ctxDe(tenant);
const agg = () => crypto.randomUUID();
const mais = (ms) => new Date(Date.now() + ms);

before(async () => { ({ tenant } = await carregarTenants()); msg = await conexaoAtiva(tenant, 'MESSAGING'); });
beforeEach(async () => {
  Msg = mensagemProgramavel({ idempotente: true });
  instalar(Msg);
  health.resetHealthSampleSources();
  await limparPendentes(tenant);
  await limparConfig(tenant, ['integration.rate_limit.reserve_pct']);
  // A cota de um teste não vale para o seguinte: zera a cota guardada nas tentativas dessa conexão.
  await comTenant(tenant, (t) => sequelize.query('UPDATE integration.dispatch_attempts SET quota_limit = NULL, quota_remaining = NULL, quota_resets_at = NULL WHERE connection_id = :c', { replacements: { c: msg.id }, transaction: t }));
});
after(async () => { health.resetHealthSampleSources(); await limparConfig(tenant, ['integration.rate_limit.reserve_pct']); restaurar(); await sequelize.close(); });

const texto = (extra = {}) => enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: `+5541${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, text: 'Olá' }, ...extra });
const rodar = (now = new Date(), limit = 20) => dispatch.runDispatchCycle(ctx(), { now, limit });

test('quota_extract_headers_ratelimit', async () => {
  const agora = new Date('2026-10-29T12:00:00Z');
  const x = dispatch.extractQuotaFromHeaders;
  const epoch = Math.floor(agora.getTime() / 1000) + 3600;
  assert.deepEqual(x({ headers: { 'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': '190', 'X-RateLimit-Reset': String(epoch) } }, agora), { limit: 1000, remaining: 190, resetsAt: new Date(epoch * 1000) }, 'reset em segundos desde 1970');
  assert.equal(x({ headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '90' } }, agora).resetsAt.getTime(), agora.getTime() + 90000, 'reset em segundos até a renovação');
  assert.equal(x({ headers: { 'RateLimit-Limit': '10', 'RateLimit-Remaining': '3', 'RateLimit-Reset': '2026-10-29T13:00:00Z' } }, agora).resetsAt.toISOString(), '2026-10-29T13:00:00.000Z', 'sem o X- e com data ISO');
  assert.deepEqual(x({ headers: { get: (k) => ({ 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '4' })[k] ?? null } }, agora), { limit: 5, remaining: 4, resetsAt: null }, 'objeto Headers com get()');
  assert.equal(x({ headers: { 'Retry-After': '120' } }, agora).resetsAt.getTime(), agora.getTime() + 120000, 'Retry-After vira a renovação');
  assert.equal(x({ headers: { 'content-type': 'application/json' } }, agora), null);
  assert.equal(x({}, agora), null);
  assert.equal(x({ headers: { 'x-ratelimit-remaining': '-3', 'x-ratelimit-limit': 'abc' } }, agora), null, 'valor inválido não vira cota');
  // O adapter padrão lê da resposta (raw.headers) e do erro (headers); o que não é cota devolve null e o que lança não derruba.
  const adapter = new Msg(null);
  assert.equal(adapter.extractQuota({ raw: { headers: { 'x-ratelimit-limit': '9', 'x-ratelimit-remaining': '1' } } }).remaining, 1);
  assert.equal(adapter.extractQuota(erroHttp(429, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '9' } })).remaining, 0);
  assert.equal(dispatch.extractQuotaSafely({ extractQuota() { throw new Error('quebrou'); } }, {}, agora), null);
  // Na rotina real: a resposta traz os cabeçalhos e a cota aparece em provider_health.
  const reset = mais(3600000);
  Msg.S.fila('sendText', [{ resposta: { status: 'SENT', externalResourceId: 'm-1', raw: { headers: { 'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': '700', 'X-RateLimit-Reset': String(Math.floor(reset.getTime() / 1000)) } } } }]);
  const r = await texto();
  await rodar();
  const [saude] = await comTenant(tenant, async (t) => (await sequelize.query('SELECT quota_limit, quota_remaining, quota_resets_at FROM integration.provider_health WHERE connection_id = :c AND window_minutes = 0', { replacements: { c: msg.id }, transaction: t }))[0]);
  assert.deepEqual([saude.quota_limit, saude.quota_remaining], [1000, 700], 'provider_health.quota_remaining mostrado');
  assert.ok(Math.abs(saude.quota_resets_at.getTime() - Math.floor(reset.getTime() / 1000) * 1000) < 1000);
  const t = await tentativas(tenant, r.dispatchId);
  assert.deepEqual([t[0].quota_limit, t[0].quota_remaining], [1000, 700]);
  assert.equal((await erros(tenant, msg.id, 'QUOTA_LOW')).filter((e) => e.status === 'OPEN').length, 0, '70% restante: sem alerta');
});

test('quota_reserva_prioriza_essenciais', async () => {
  const reset = mais(3600000);
  Msg.S.quota = () => ({ limit: 1000, remaining: 190, resetsAt: reset });
  const primeira = await texto();
  await rodar();
  assert.equal((await ler(tenant, primeira.dispatchId)).status, 'SUBMITTED', 'antes de saber a cota o envio sai');
  const alertas = await erros(tenant, msg.id, 'QUOTA_LOW');
  assert.ok(alertas.length >= 1, 'abaixo de 20% da cota: alerta QUOTA_LOW');
  assert.equal(alertas[alertas.length - 1].severity, 'MEDIUM');
  // 190 de 1000 (19%) está abaixo da reserva de 20%: mensagem em massa espera; essencial e perigoso seguem.
  const campanha = await texto();
  const pagamento = await texto({ essential: true });
  const perigosa = await texto({ opClass: 'DANGEROUS' });
  const chamadasAntes = Msg.S.chamadas.length;
  await rodar();
  const c = await ler(tenant, campanha.dispatchId);
  assert.equal(c.status, 'RETRY_WAIT', 'a campanha espera a renovação da cota');
  assert.equal(c.attempts, 0);
  assert.ok(Math.abs(new Date(c.next_attempt_at).getTime() - reset.getTime()) < 1500, 'até o quota_resets_at');
  assert.equal((await ler(tenant, pagamento.dispatchId)).status, 'SUBMITTED', 'a confirmação de pagamento (essencial) segue');
  assert.equal((await ler(tenant, perigosa.dispatchId)).status, 'SUBMITTED', 'a operação perigosa segue');
  assert.equal(Msg.S.chamadas.length - chamadasAntes, 2);
  // A reserva é parâmetro da empresa: com 10%, os 19% restantes bastam e a campanha sai.
  await config(tenant, 'integration.rate_limit.reserve_pct', 10);
  await forcar(tenant, campanha.dispatchId, "next_attempt_at = now() - interval '1 second'");
  Msg.S.quota = () => ({ limit: 1000, remaining: 190, resetsAt: reset });
  await rodar();
  assert.equal((await ler(tenant, campanha.dispatchId)).status, 'SUBMITTED');
  await assert.rejects(comTenant(tenant, (t) => require('../../../src/features/settings/settings.service').upsertSetting('integration.rate_limit.reserve_pct', 101, tenant, tenant.userId, t)), (e) => e.statusCode === 400);
});

test('quota_429_respeita_retry_after_e_conta_rate_limit', async () => {
  dispatch.registerDispatchHealthSource();
  const r = await texto();
  Msg.S.fila('sendText', [{ erro: erroHttp(429, { headers: { 'retry-after': '120', 'x-ratelimit-limit': '500', 'x-ratelimit-remaining': '0' } }) }]);
  const t0 = new Date();
  await rodar(t0);
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'RETRY_WAIT');
  assert.equal(new Date(l.next_attempt_at).getTime() - t0.getTime(), 120000, 'próximo envio em 120 s');
  assert.equal(l.attempts, 0);
  const [tent] = await tentativas(tenant, r.dispatchId);
  assert.equal(tent.rate_limited, true);
  assert.equal(tent.quota_remaining, 0, 'o cabeçalho do 429 também informa a cota');
  // rate_limit_count aparece na saúde do fornecedor (janela de 5 minutos e linha atual).
  const connection = await comTenant(tenant, (t) => IntegrationConnection.findByPk(msg.id, { transaction: t }));
  const atual = await comTenant(tenant, (t) => health.aggregateConnectionHealth(connection, { now: new Date() }, t));
  assert.ok(atual.rate_limit_count >= 1, `rate_limit_count=${atual.rate_limit_count}`);
  assert.equal(atual.quota_remaining, 0);
  assert.equal(atual.quota_limit, 500);
  assert.equal(atual.auth_failures, 0);
  const sample = await comTenant(tenant, (t) => health.collectSample ? health.collectSample({ connection, from: new Date(Date.now() - 300000), to: new Date(), windowMinutes: 5 }, t) : null);
  if (sample) assert.ok(sample.calls.every((c) => c.ok === true || c.ok === false));
});

test('quota_zerada_pausa_nao_essenciais', async () => {
  const reset = mais(3600000);
  Msg.S.quota = () => ({ limit: 100, remaining: 0, resetsAt: reset });
  const primeira = await texto();
  await rodar();
  assert.equal((await ler(tenant, primeira.dispatchId)).status, 'SUBMITTED');
  const comum = await texto();
  const essencial = await texto({ essential: true });
  await rodar();
  const c = await ler(tenant, comum.dispatchId);
  assert.equal(c.status, 'RETRY_WAIT', 'cota zerada: não essencial pausa');
  assert.ok(Math.abs(new Date(c.next_attempt_at).getTime() - reset.getTime()) < 1500, 'até o quota_resets_at');
  assert.equal(c.attempts, 0);
  assert.equal((await ler(tenant, essencial.dispatchId)).status, 'SUBMITTED', 'o essencial não pausa');
  // Operação sem fila: 429 INTEGRATION_QUOTA_EXHAUSTED com o instante de volta.
  const connection = await comTenant(tenant, (t) => IntegrationConnection.findByPk(msg.id, { transaction: t }));
  const fake = { essential: false, criticalityOp: 'SAFE' };
  await assert.rejects(comTenant(tenant, (t) => dispatch.assertQuotaAvailable({ ctx: ctx(), dispatch: fake, connection, now: new Date(), transaction: t })), (e) => e.statusCode === 429 && e.code === 'INTEGRATION_QUOTA_EXHAUSTED' && /reagendada/.test(e.message) && Boolean(e.details.retryAt));
  assert.equal(await comTenant(tenant, (t) => dispatch.assertQuotaAvailable({ ctx: ctx(), dispatch: { essential: true, criticalityOp: 'SAFE' }, connection, now: new Date(), transaction: t })), true);
  // Depois da renovação a pausa termina sozinha.
  Msg.S.quota = null;
  await forcar(tenant, comum.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar(new Date(reset.getTime() + 60000));
  assert.equal((await ler(tenant, comum.dispatchId)).status, 'SUBMITTED');
});

test('quota_fonte_de_saude_conta_chamadas_e_falhas', async () => {
  const desde = new Date();
  await texto();
  const falha = await texto();
  const invalida = await texto();
  Msg.S.fila('sendText', [{ resposta: { status: 'SENT', externalResourceId: 'a' } }, { erro: erroHttp(503) }, { erro: erroHttp(422) }]);
  await rodar();
  const connection = await comTenant(tenant, (t) => IntegrationConnection.findByPk(msg.id, { transaction: t }));
  const amostra = await comTenant(tenant, (t) => dispatch.dispatchHealthSample({ connection, from: desde, to: new Date(Date.now() + 1000) }, t));
  assert.equal(amostra.calls.length, 2, 'sucesso e 503 contam; o 422 (dado nosso) não');
  assert.deepEqual(amostra.calls.map((c) => c.ok).sort(), [false, true]);
  assert.ok(amostra.calls.every((c) => c.latencyMs >= 0));
  assert.equal(amostra.rateLimitCount, 0);
  assert.equal(amostra.authFailures, 0);
  assert.equal(amostra.retriesTotal, 0);
  assert.ok(amostra.lastSampleAt);
  assert.equal((await ler(tenant, invalida.dispatchId)).status, 'FAILED');
  assert.equal((await ler(tenant, falha.dispatchId)).status, 'RETRY_WAIT');
  assert.ok(amostra.backlogCount >= 0);
  // Registrada no agregador, a fonte entra na linha de saúde da connection.
  dispatch.registerDispatchHealthSource();
  const linha = await comTenant(tenant, (t) => health.aggregateConnectionHealth(connection, { now: new Date() }, t));
  assert.ok(linha.calls_total >= 2);
  assert.ok(Number(linha.success_rate) <= 100);
  assert.ok(linha.latency_p95_ms >= 0);
});
