'use strict';

// Marco 9, M9-D216 — retry por classe de erro no worker de envios: TRANSIENT com backoff e jitter, RATE_LIMIT, UNKNOWN, VALIDATION,
// fila morta e contador. Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, pagamento, tentativas, eventos, erros, instalar, restaurar, forcar, ler, dispatch, rodarEVencer,
} = require('../_helpers/m9d214Env');
const { bancoProgramavel, mensagemProgramavel, erroHttp } = require('../_helpers/m9d214Scripted');
const { clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let banco;
let msg;
let Banco;
let Msg;
const agg = () => crypto.randomUUID();
const ctx = () => ctxDe(tenant);

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
  msg = await conexaoAtiva(tenant, 'MESSAGING');
});
beforeEach(async () => {
  Banco = bancoProgramavel();
  Msg = mensagemProgramavel({ idempotente: true });
  instalar(Banco);
  instalar(Msg);
  dispatch.registerUnknownReconciler(null);
  clearCircuitCache();
  await limparPendentes(tenant);
});
after(async () => { dispatch.registerUnknownReconciler(null); restaurar(); await sequelize.close(); });

const consulta = (extra = {}) => enfileirar(tenant, { connectionId: banco.id, operation: 'getPaymentStatus', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: { externalResourceId: `p-${agg()}` }, ...extra });
const pagar = (extra = {}) => enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento(), ...extra });
const texto = (extra = {}) => enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990000', text: 'Olá' }, ...extra });
const rodar = (now) => dispatch.runDispatchCycle(ctx(), { now: now || new Date() });
const faltaMs = (linha, now) => new Date(linha.next_attempt_at).getTime() - now.getTime();

test('retry_transient_backoff_exponencial_com_jitter', async () => {
  const r = await texto();
  Msg.S.fila('sendText', [{ erro: erroHttp(503) }, { erro: erroHttp(503) }, { resposta: { status: 'DELIVERED', externalResourceId: 'm-ok' } }]);
  const n1 = new Date();
  await rodar(n1);
  const a = await ler(tenant, r.dispatchId);
  assert.equal(a.status, 'RETRY_WAIT');
  assert.equal(a.attempts, 1);
  assert.equal(a.last_error_class, 'TRANSIENT');
  const [min1, max1] = dispatch.backoffRangeMs(1, { base_delay_ms: 5000, factor: 2, cap_delay_ms: 1800000, jitter_pct: 25 });
  assert.deepEqual([min1, max1], [3750, 6250]);
  assert.ok(faltaMs(a, n1) >= min1 && faltaMs(a, n1) <= max1, `atraso da 1ª falha dentro de 5 s ± 25% (${faltaMs(a, n1)} ms)`);
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  const n2 = new Date();
  await rodar(n2);
  const b = await ler(tenant, r.dispatchId);
  assert.deepEqual([b.status, b.attempts], ['RETRY_WAIT', 2]);
  assert.ok(faltaMs(b, n2) >= 7500 && faltaMs(b, n2) <= 12500, `atraso da 2ª falha dentro de 10 s ± 25% (${faltaMs(b, n2)} ms)`);
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  const c = await ler(tenant, r.dispatchId);
  assert.equal(c.status, 'CONFIRMED', 'CONFIRMED na 3ª tentativa');
  assert.equal(c.attempts, 3);
  assert.equal((await tentativas(tenant, r.dispatchId)).map((t) => t.outcome).join(','), 'ERROR,ERROR,SUCCESS');
  assert.equal(Msg.S.chamadas.length, 3);
  assert.equal(new Set(Msg.S.chamadas.map((x) => x.meta.idempotencyKey)).size, 1, 'as três tentativas levaram a MESMA chave de idempotência');
  // Função de atraso: sem jitter 5, 10, 20, 40, 80, 160, 320, 640 s; teto de 30 min; 3ª com jitter entre 15 e 25 s.
  const sem = { base_delay_ms: 5000, factor: 2, cap_delay_ms: 1800000, jitter_pct: 0 };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => dispatch.backoffMs(n, sem) / 1000), [5, 10, 20, 40, 80, 160, 320, 640]);
  assert.equal(dispatch.backoffMs(20, sem), 1800000, 'o teto vale');
  assert.deepEqual(dispatch.backoffRangeMs(3, { ...sem, jitter_pct: 25 }), [15000, 25000]);
  assert.equal(dispatch.backoffMs(3, { ...sem, jitter_pct: 25 }, () => 0), 15000);
  assert.equal(dispatch.backoffMs(3, { ...sem, jitter_pct: 25 }, () => 0.999999), 25000);
});

test('retry_rate_limit_respeita_retry_after', async () => {
  const r = await texto();
  Msg.S.fila('sendText', [{ erro: erroHttp(429, { headers: { 'retry-after': '120' } }) }]);
  const agora = new Date();
  await rodar(agora);
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'RETRY_WAIT');
  assert.equal(faltaMs(l, agora), 120000, 'espera exatamente o Retry-After');
  assert.equal(l.attempts, 0, '429 não conta como tentativa de falha');
  assert.equal(l.last_error_class, 'RATE_LIMIT');
  const t = await tentativas(tenant, r.dispatchId);
  assert.equal(t.length, 1);
  assert.equal(t[0].rate_limited, true, 'a tentativa fica marcada para o rate_limit_count da saúde');
  // Retry-After como data HTTP.
  const r2 = await texto({ payload: { to: '+5541999990001', text: 'Oi' } });
  const em = new Date(Date.now() + 90000);
  Msg.S.fila('sendText', [{ erro: erroHttp(429, { headers: { 'retry-after': em.toUTCString() } }) }]);
  await rodar(new Date());
  const l2 = await ler(tenant, r2.dispatchId);
  assert.ok(Math.abs(new Date(l2.next_attempt_at).getTime() - em.getTime()) < 2500, 'data HTTP entendida (precisão de segundos)');
  assert.equal(dispatch.parseRetryAfterMs('abc'), null);
  assert.equal(dispatch.parseRetryAfterMs('2.5'), 2500);
});

test('retry_rate_limit_retry_after_acima_do_teto', async () => {
  const r = await texto();
  Msg.S.fila('sendText', [{ erro: erroHttp(429, { headers: { 'retry-after': '999999' } }) }]);
  const agora = new Date();
  await rodar(agora);
  const l = await ler(tenant, r.dispatchId);
  assert.equal(faltaMs(l, agora), 3600000, 'espera o teto integration.retry.rate_limit_max_wait_s (3600 s)');
  const alertas = await erros(tenant, msg.id, 'INTEGRATION_RETRY_AFTER_EXCEEDS_CAP');
  assert.ok(alertas.length >= 1, 'a connection ganha alerta');
  assert.equal(alertas[0].severity, 'MEDIUM');
  assert.equal(l.attempts, 0);
});

test('retry_validation_nunca_repete', async () => {
  const r = await texto();
  Msg.S.fila('sendText', [{ erro: erroHttp(422, { message: 'CPF inválido 123.456.789-09' }) }]);
  await rodar();
  await rodarEVencer(tenant, r.dispatchId);
  await rodar();
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'FAILED');
  assert.equal(l.attempts, 1, '0 retries');
  assert.equal(Msg.S.chamadas.length, 1);
  assert.equal(l.last_error_class, 'VALIDATION');
  const e = await erros(tenant, msg.id, 'HTTP_422');
  assert.equal(e[e.length - 1].severity, 'MEDIUM');
  assert.ok(!JSON.stringify(e[e.length - 1]).includes('123.456.789'), 'sem payload nem texto do fornecedor no erro');
  assert.match(e[e.length - 1].message, /corrija o dado/);
  const ev = await eventos(tenant, dispatch.EVENTS.FAILED, r.dispatchId);
  assert.equal(ev.length, 1, 'o domínio recebe integration.dispatch.failed');
  assert.equal(ev[0].payload_json.errorClass, 'VALIDATION');
  // Retry humano em VALIDATION sem correção: 409; sem permissão: 403 em português.
  const comPermissao = { ...ctx(), permissions: new Set(['integration:retry']) };
  await assert.rejects(comTenant(tenant, (t) => dispatch.retryDispatchManually(comPermissao, r.dispatchId, t)), (x) => x.statusCode === 409 && x.code === 'INTEGRATION_RETRY_NOT_ALLOWED' && /permanente/.test(x.message));
  await assert.rejects(comTenant(tenant, (t) => dispatch.retryDispatchManually(ctx(), r.dispatchId, t)), (x) => x.statusCode === 403 && x.code === 'PERMISSION_DENIED' && x.message === 'Você não tem permissão para repetir envios.');
});

test('retry_unknown_vai_para_reconciliacao', async () => {
  const entregues = [];
  dispatch.registerUnknownReconciler(async ({ dispatch: d, classification }) => { entregues.push([d.id, classification.class, d.status]); });
  const r = await pagar();
  Banco.S.fila('submitPayment', [{ erro: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }]);
  await rodar();
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'UNKNOWN', 'timeout depois do envio em operação perigosa: UNKNOWN');
  assert.ok(l.unknown_since);
  assert.deepEqual(entregues, [[r.dispatchId, 'UNKNOWN', 'UNKNOWN']], 'o envio é entregue à reconciliação (D215), uma vez');
  await rodarEVencer(tenant, r.dispatchId);
  await rodar();
  assert.equal(Banco.S.chamadas.length, 1, 'nunca repete operação perigosa por conta própria');
  const e = await erros(tenant, banco.id, 'ETIMEDOUT');
  assert.equal(e[e.length - 1].severity, 'CRITICAL');
  // Operação segura: tentativas limitadas (integration.unknown.max_reconcile_attempts, 5) e depois a fila morta.
  const s = await consulta();
  Banco.S.fila('getPaymentStatus', [{ erro: new Error('resposta ilegível') }]);
  for (let i = 0; i < 6; i += 1) await rodarEVencer(tenant, s.dispatchId);
  const f = await ler(tenant, s.dispatchId);
  assert.equal(f.status, 'DEAD_LETTER');
  assert.equal(f.reconcile_attempts, 4, 'a 5ª incerteza esgota o limite e vai à fila morta');
  assert.equal(Banco.S.chamadas.filter((c) => c.op === 'getPaymentStatus').length, 5);
});

test('retry_esgota_vai_para_dlq', async () => {
  const r = await consulta();
  Banco.S.fila('getPaymentStatus', [{ erro: erroHttp(503) }]);
  for (let i = 0; i < 8; i += 1) await rodarEVencer(tenant, r.dispatchId);
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'DEAD_LETTER', 'DEAD_LETTER na 8ª');
  assert.equal(l.attempts, 8);
  assert.equal(l.max_attempts, 8);
  assert.equal(Banco.S.chamadas.length, 8);
  const e = await erros(tenant, banco.id, 'HTTP_503');
  assert.equal(e[e.length - 1].severity, 'HIGH', 'esgotou: erro HIGH');
  assert.equal((await eventos(tenant, dispatch.EVENTS.FAILED, r.dispatchId)).length, 1);
  await rodar();
  assert.equal(Banco.S.chamadas.length, 8, 'a fila morta não é tentada de novo');
});
