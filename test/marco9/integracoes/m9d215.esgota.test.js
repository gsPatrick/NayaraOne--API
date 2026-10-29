'use strict';

// Marco 9, M9-D215 — consultas inconclusivas até esgotar, webhook que resolve, operação segura e fila morta que só sai pelo retry humano.
// Testes 6, 7, 10 e 12 da demanda. Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparTudo, limparConfig, config, enfileirar, pagamento, eventos, erros, instalar, restaurar, forcar, ler, dispatch,
  auditoria, bancoReconciliavel, erroHttp, mensagemProgramavel,
} = require('../_helpers/m9d215Env');
const { clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let banco;
let msg;
let Banco;
let Msg;
const agg = () => crypto.randomUUID();
const ctx = (extra = {}) => ctxDe(tenant, extra);
const CHAVES = ['integration.unknown.max_reconcile_attempts', 'integration.unknown.reconcile_intervals_s'];

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
  msg = await conexaoAtiva(tenant, 'MESSAGING');
});
beforeEach(async () => {
  Banco = bancoReconciliavel();
  Msg = mensagemProgramavel({ idempotente: true });
  instalar(Banco);
  instalar(Msg);
  clearCircuitCache();
  await limparConfig(tenant, CHAVES);
  await limparTudo(tenant);
});
after(async () => { await limparConfig(tenant, CHAVES); restaurar(); await sequelize.close(); });

const pagar = (extra = {}) => enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento(), ...extra });
const rodar = () => dispatch.runDispatchCycle(ctx(), { now: new Date() });
const envios = () => Banco.S.chamadas.filter((c) => c.op === 'submitPayment');
async function incerto() {
  const r = await pagar();
  Banco.S.fila('submitPayment', [{ recebeEDaTimeout: true }]);
  await rodar();
  return r;
}
const faltaS = (linha, now) => Math.round((new Date(linha.next_attempt_at).getTime() - now.getTime()) / 1000);

test('unknown_inconclusivo_permanece_ate_esgotar', async () => {
  const r = await incerto();
  Banco.S.consultaFalha = erroHttp(503);
  const t0 = new Date(Date.now() + 40000);
  const esperas = [];
  for (let i = 1; i <= 4; i += 1) {
    const rec = await dispatch.reconcileDispatch(ctx(), r.dispatchId, { now: t0 });
    assert.deepEqual([rec.status, rec.verdict], ['UNKNOWN', 'INCONCLUSIVE'], `consulta ${i} inconclusiva: continua UNKNOWN`);
    const l = await ler(tenant, r.dispatchId);
    assert.equal(l.reconcile_attempts, i);
    esperas.push(faltaS(l, t0));
  }
  assert.deepEqual(esperas, [120, 600, 3600, 21600], 'esperas do livro entre as consultas: 2 min, 10 min, 1 h e 6 h');
  assert.equal((await ler(tenant, r.dispatchId)).status, 'UNKNOWN');
  // Antes da espera, o job não consulta; a consulta devida roda uma vez.
  const antes = Banco.S.consultas.length;
  assert.equal((await dispatch.reconcileDue(ctx(), { now: t0 })).due, 0);
  assert.equal(Banco.S.consultas.length, antes);
  // A 5ª consulta inconclusiva esgota: DEAD_LETTER, incidente CRITICAL e revisão humana.
  const rec5 = await dispatch.reconcileDispatch(ctx(), r.dispatchId, { now: t0 });
  assert.equal(rec5.status, 'DEAD_LETTER');
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.dead_letter_reason, 'UNKNOWN_UNRESOLVED');
  assert.equal(l.reconcile_attempts, 5);
  const inc = await erros(tenant, banco.id, 'UNKNOWN_UNRESOLVED');
  assert.equal(inc[inc.length - 1].severity, 'CRITICAL');
  const ev = await eventos(tenant, dispatch.EVENTS.NEEDS_MANUAL_REVIEW, r.dispatchId);
  assert.equal(ev.length, 1, 'o domínio recebe integration.dispatch.needs_manual_review uma vez');
  assert.equal(ev[0].payload_json.reason, 'UNKNOWN_UNRESOLVED');
  assert.equal(ev[0].payload_json.reconcileAttempts, 5);
  // Nunca repete a ordem: nem o worker, nem o job.
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal((await dispatch.reconcileDue(ctx(), { now: new Date(Date.now() + 86400000) })).due, 0);
  assert.equal(envios().length, 1, 'uma única ordem de pagamento enviada');
  assert.equal(Banco.S.todos.length, 1);
  // O número de consultas e as esperas são parâmetros da empresa.
  await config(tenant, 'integration.unknown.max_reconcile_attempts', 3);
  await config(tenant, 'integration.unknown.reconcile_intervals_s', '5,10');
  const p = await incerto();
  const t1 = new Date(Date.now() + 40000);
  await dispatch.reconcileDispatch(ctx(), p.dispatchId, { now: t1 });
  assert.equal(faltaS(await ler(tenant, p.dispatchId), t1), 10);
  await dispatch.reconcileDispatch(ctx(), p.dispatchId, { now: t1 });
  assert.equal(faltaS(await ler(tenant, p.dispatchId), t1), 10, 'passou do fim da lista: repete a última espera');
  assert.equal((await dispatch.reconcileDispatch(ctx(), p.dispatchId, { now: t1 })).status, 'DEAD_LETTER', 'esgota na 3ª consulta');
});

test('unknown_webhook_resolve', async () => {
  const r = await incerto();
  const l = await ler(tenant, r.dispatchId);
  const evento = (extra) => ({ providerCode: 'bank-sandbox', idempotencyKey: l.idempotency_key, status: 'PAID', source: 'WEBHOOK_SIGNED', ...extra });
  const resolver = (e) => comTenant(tenant, (t) => dispatch.resolveDispatchByEvent(ctx(), e, {}, t));
  assert.deepEqual(await resolver(evento({ idempotencyKey: 'outra-chave' })), { matched: false }, 'evento de outro envio não toca este');
  await assert.rejects(resolver({ providerCode: 'bank-sandbox' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_EVENT_INVALID');
  const w = await resolver(evento({}));
  assert.equal(w.status, 'CONFIRMED');
  const c = await ler(tenant, r.dispatchId);
  assert.equal(c.status, 'CONFIRMED');
  assert.equal(c.unknown_since, null);
  assert.ok(c.confirmed_at);
  assert.equal((await eventos(tenant, dispatch.EVENTS.CONFIRMED, r.dispatchId)).length, 1);
  // O mesmo evento outra vez não muda nada; a reconciliação seguinte vê CONFIRMED e não consulta.
  const de_novo = await resolver(evento({}));
  assert.deepEqual([de_novo.matched, de_novo.changed], [true, false]);
  assert.equal((await dispatch.reconcileDispatch(ctx(), r.dispatchId)).skipped, true);
  assert.equal(Banco.S.consultas.length, 0, 'o webhook resolveu sem consultar o banco');
  // Pelo id externo, e a recusa final também resolve (FAILED).
  const s = await incerto();
  Banco.S.pagamentos.get((await ler(tenant, s.dispatchId)).idempotency_key).status = 'PROCESSING';
  await dispatch.reconcileDispatch(ctx(), s.dispatchId, { now: new Date(Date.now() + 40000) });
  const ls = await ler(tenant, s.dispatchId);
  assert.equal(ls.status, 'SUBMITTED');
  const f = await resolver({ providerCode: 'bank-sandbox', externalResourceId: ls.external_resource_id, status: 'REJECTED' });
  assert.equal(f.status, 'FAILED');
  assert.equal((await auditoria(tenant, s.dispatchId, 'integration.dispatch.reconciled')).length, 2);
});

test('unknown_safe_repete_com_backoff', async () => {
  // Resposta ilegível de uma operação SEGURA (UNKNOWN pela classe): repete com backoff, sem consultar o fornecedor.
  const t = await enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990000', text: 'Olá' } });
  Msg.S.fila('sendText', [{ resposta: { status: undefined } }, { resposta: { status: 'DELIVERED', externalResourceId: 'm-ok' } }]);
  const n1 = new Date();
  await dispatch.runDispatchCycle(ctx(), { now: n1 });
  const a = await ler(tenant, t.dispatchId);
  assert.deepEqual([a.status, a.last_error_class, a.reconcile_attempts], ['RETRY_WAIT', 'UNKNOWN', 1]);
  const [min, max] = dispatch.backoffRangeMs(1, { base_delay_ms: 5000, factor: 2, cap_delay_ms: 1800000, jitter_pct: 25 });
  const espera = new Date(a.next_attempt_at).getTime() - n1.getTime();
  assert.ok(espera >= min && espera <= max, `backoff do livro (${espera} ms)`);
  await forcar(tenant, t.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal((await ler(tenant, t.dispatchId)).status, 'CONFIRMED');
  // Um envio SEGURO que ficou em UNKNOWN (linha antiga) volta a RETRY_WAIT pela reconciliação, com backoff e sem consulta.
  const u = await enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990001', text: 'Oi' } });
  await forcar(tenant, u.dispatchId, "status = 'UNKNOWN', attempts = 1, unknown_since = now(), next_attempt_at = NULL");
  const n2 = new Date(Date.now() + 40000);
  const rec = await dispatch.reconcileDispatch(ctx(), u.dispatchId, { now: n2 });
  assert.equal(rec.status, 'RETRY_WAIT');
  const lu = await ler(tenant, u.dispatchId);
  const e2 = new Date(lu.next_attempt_at).getTime() - n2.getTime();
  assert.ok(e2 >= min && e2 <= max, `backoff (${e2} ms)`);
  assert.equal(Msg.S.chamadas.filter((c) => c.op === 'getStatus').length, 0, 'operação segura repete, não consulta');
});

test('unknown_dead_letter_so_sai_pelo_retry_humano', async () => {
  await config(tenant, 'integration.unknown.max_reconcile_attempts', 1);
  const r = await incerto();
  Banco.S.consultaFalha = erroHttp(503);
  assert.equal((await dispatch.reconcileDispatch(ctx(), r.dispatchId, { now: new Date(Date.now() + 40000) })).status, 'DEAD_LETTER');
  const antes = await ler(tenant, r.dispatchId);
  assert.equal(antes.dead_letter_reason, 'UNKNOWN_UNRESOLVED');
  // Nem o motor, nem a transição direta, nem o worker tiram o envio da fila morta.
  await assert.rejects(comTenant(tenant, (t) => dispatch.transitionDispatch(ctx(), r.dispatchId, 'RETRY_WAIT', {}, { reconciled: true }, t)), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_DISPATCH_INVALID_TRANSITION');
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal(envios().length, 1);
  assert.equal((await ler(tenant, r.dispatchId)).status, 'DEAD_LETTER');
  // O retry humano exige a permissão; autorizado, reabre o MESMO envio (mesma chave) e o banco devolve o mesmo pagamento.
  await assert.rejects(comTenant(tenant, (t) => dispatch.retryDispatchManually(ctx(), r.dispatchId, t)), (e) => e.statusCode === 403 && e.code === 'PERMISSION_DENIED');
  Banco.S.consultaFalha = null;
  await comTenant(tenant, (t) => dispatch.retryDispatchManually(ctx({ permissions: new Set(['integration:retry']) }), r.dispatchId, t));
  const reaberto = await ler(tenant, r.dispatchId);
  assert.equal(reaberto.status, 'RETRY_WAIT');
  assert.equal(reaberto.max_attempts, antes.max_attempts + 3);
  assert.equal(reaberto.dead_letter_reason, null);
  assert.equal(reaberto.idempotency_key, antes.idempotency_key);
  await rodar();
  assert.equal((await ler(tenant, r.dispatchId)).status, 'SUBMITTED');
  assert.equal(Banco.S.todos.length, 1, 'mesma chave: o banco devolveu o pagamento que já tinha');
  // Envio já confirmado não é repetido: 409 em português.
  await forcar(tenant, r.dispatchId, "status = 'CONFIRMED', confirmed_at = now()");
  await assert.rejects(comTenant(tenant, (t) => dispatch.retryDispatchManually(ctx({ permissions: new Set(['integration:retry']) }), r.dispatchId, t)),
    (e) => e.statusCode === 409 && e.code === 'INTEGRATION_DISPATCH_ALREADY_CONFIRMED' && e.message === 'Esta operação já foi confirmada pelo fornecedor.');
});
