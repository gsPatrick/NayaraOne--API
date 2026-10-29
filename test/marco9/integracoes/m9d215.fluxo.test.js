'use strict';

// Marco 9, M9-D215 — timeout vira UNKNOWN e a reconciliação consulta o fornecedor antes de qualquer repetição de operação perigosa.
// Testes 1 a 5 da demanda. Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparTudo, enfileirar, pagamento, eventos, erros, instalar, restaurar, forcar, ler, dispatch,
  auditoria, bancoReconciliavel, erroHttp,
} = require('../_helpers/m9d215Env');
const { clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let banco;
let Banco;
const agg = () => crypto.randomUUID();
const ctx = () => ctxDe(tenant);
const depois = (s) => new Date(Date.now() + s * 1000);

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
});
beforeEach(async () => {
  Banco = bancoReconciliavel();
  instalar(Banco);
  clearCircuitCache();
  await limparTudo(tenant);
});
after(async () => { restaurar(); await sequelize.close(); });

const pagar = (extra = {}) => enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento(), ...extra });
const rodar = () => dispatch.runDispatchCycle(ctx(), { now: new Date() });
const envios = () => Banco.S.chamadas.filter((c) => c.op === 'submitPayment');
const reconciliar = (id, now) => dispatch.reconcileDispatch(ctx(), id, { now: now || new Date() });
/** Leva um pagamento a UNKNOWN: o banco recebeu e a resposta se perdeu. */
async function incerto(passo = { recebeEDaTimeout: true }, extra = {}) {
  const r = await pagar(extra);
  Banco.S.fila('submitPayment', [passo]);
  await rodar();
  return r;
}

test('unknown_timeout_pagamento_nao_duplica', async () => {
  const r = await incerto();
  const u = await ler(tenant, r.dispatchId);
  assert.equal(u.status, 'UNKNOWN', 'timeout depois do envio: UNKNOWN');
  assert.equal(envios().length, 1);
  // O worker nunca repete sozinho: nem na rodada seguinte, nem com o envio vencido.
  await rodar();
  await rodar();
  assert.equal(envios().length, 1, 'nenhuma nova submissão sem consulta');
  // Antes da 1ª espera (30 s) o job não consulta; passada a espera, consulta pela chave e acha o pagamento em processamento.
  assert.equal((await dispatch.reconcileDue(ctx(), { now: new Date() })).due, 0, 'antes dos 30 s nada é devido');
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal(envios().length, 1, 'nem com a data vencida o worker reenvia um envio incerto');
  const j = await dispatch.reconcileDue(ctx(), { now: depois(31) });
  assert.deepEqual([j.due, j.reconciled], [1, 1]);
  const s = await ler(tenant, r.dispatchId);
  assert.equal(s.status, 'SUBMITTED', 'o banco tem o pagamento em andamento: SUBMITTED, sem nova ordem');
  assert.equal(s.unknown_since, null);
  assert.equal(Banco.S.consultas[0].metodo, 'key', 'a 1ª estratégia é a chave de idempotência');
  // O webhook assinado fecha: um único pagamento no banco.
  const w = await comTenant(tenant, (t) => dispatch.resolveDispatchByEvent(ctx(), { providerCode: 'bank-sandbox', idempotencyKey: s.idempotency_key, status: 'PAID', source: 'WEBHOOK_SIGNED' }, {}, t));
  assert.deepEqual([w.matched, w.changed, w.status], [true, true, 'CONFIRMED']);
  assert.equal((await ler(tenant, r.dispatchId)).status, 'CONFIRMED');
  assert.equal(Banco.S.todos.length, 1, 'um único pagamento no banco');
  assert.equal(envios().length, 1, 'uma única ordem enviada');
  assert.equal((await eventos(tenant, dispatch.EVENTS.CONFIRMED, r.dispatchId)).length, 1);
});

test('unknown_timeout_leitura_apos_envio_vira_unknown', async () => {
  const r = await incerto();
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'UNKNOWN');
  assert.ok(l.unknown_since, 'unknown_since = agora');
  assert.equal(l.reconcile_attempts, 0);
  assert.equal(l.last_error_class, 'UNKNOWN');
  const e = await erros(tenant, banco.id, 'ETIMEDOUT');
  assert.equal(e[e.length - 1].severity, 'CRITICAL', 'erro UNKNOWN com severidade CRITICAL em operação perigosa');
  // Queda da conexão depois do envio e 503 sem idempotência declarada também são UNKNOWN.
  const q = await incerto({ erro: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  assert.equal((await ler(tenant, q.dispatchId)).status, 'UNKNOWN');
});

test('unknown_conexao_recusada_e_transient', async () => {
  const r = await incerto({ erro: Object.assign(new Error('recusada'), { code: 'ECONNREFUSED' }) });
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'RETRY_WAIT', 'nada saiu: é seguro repetir');
  assert.equal(l.last_error_class, 'TRANSIENT');
  assert.equal(l.unknown_since, null);
  assert.equal((await dispatch.reconcileDue(ctx(), { now: depois(86400) })).due, 0, 'não há o que reconciliar');
  assert.equal(Banco.S.consultas.length, 0);
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal((await ler(tenant, r.dispatchId)).status, 'SUBMITTED');
  assert.equal(Banco.S.todos.length, 1);
});

test('unknown_reconcilia_confirmado', async () => {
  // Pago: CONFIRMED por consulta, evento uma vez, ids gravados, UNKNOWN encerrado.
  const a = await incerto();
  const chaveA = (await ler(tenant, a.dispatchId)).idempotency_key;
  Banco.S.pagamentos.get(chaveA).status = 'PAID';
  const ra = await reconciliar(a.dispatchId, depois(31));
  assert.deepEqual([ra.status, ra.verdict], ['CONFIRMED', 'FOUND']);
  const la = await ler(tenant, a.dispatchId);
  assert.ok(la.confirmed_at && la.external_resource_id && la.unknown_since === null);
  assert.equal(la.external_status, 'PAID');
  assert.equal((await eventos(tenant, dispatch.EVENTS.CONFIRMED, a.dispatchId)).length, 1);
  // Recusado pelo banco: FAILED com aviso ao domínio, sem repetir.
  const b = await incerto();
  Banco.S.pagamentos.get((await ler(tenant, b.dispatchId)).idempotency_key).status = 'REJECTED';
  assert.equal((await reconciliar(b.dispatchId, depois(31))).status, 'FAILED');
  const lb = await ler(tenant, b.dispatchId);
  assert.equal(lb.last_error_code, 'EXTERNAL_REJECTED');
  assert.equal((await eventos(tenant, dispatch.EVENTS.FAILED, b.dispatchId)).length, 1);
  // Em processamento: SUBMITTED.
  const c = await incerto();
  assert.equal((await reconciliar(c.dispatchId, depois(31))).status, 'SUBMITTED');
  assert.equal(envios().length, 3, 'nenhuma ordem repetida');
  assert.equal(Banco.S.todos.length, 3);
  // Auditoria da consulta: antes e depois, estratégia e resultado, sem o conteúdo do pagamento.
  const aud = await auditoria(tenant, a.dispatchId, 'integration.dispatch.reconciled');
  assert.equal(aud.length, 1);
  assert.equal(aud[0].before_json.status, 'UNKNOWN');
  assert.equal(aud[0].after_json.status, 'CONFIRMED');
  assert.equal(aud[0].after_json.result, 'FOUND');
  assert.deepEqual(aud[0].after_json.trail.map((t) => [t.strategy, t.outcome]), [['IDEMPOTENCY_KEY', 'FOUND']]);
  assert.ok(!JSON.stringify(aud[0]).includes('Fulano'), 'sem conteúdo do envio');
  // Confirmar duas vezes não repete o evento nem a transição.
  assert.deepEqual(await reconciliar(a.dispatchId), { skipped: true, status: 'CONFIRMED' });
});

test('unknown_reconcilia_inexistente_repete_mesma_chave', async () => {
  // O pedido nem chegou ao banco: a consulta pela chave diz que não existe; o envio repete com a MESMA chave e o banco tem um pagamento só.
  const r = await incerto({ semReceber: true });
  const antes = await ler(tenant, r.dispatchId);
  assert.equal(antes.status, 'UNKNOWN');
  assert.equal(Banco.S.todos.length, 0);
  const rec = await reconciliar(r.dispatchId, depois(31));
  assert.deepEqual([rec.status, rec.verdict], ['RETRY_WAIT', 'NOT_FOUND']);
  const d = await ler(tenant, r.dispatchId);
  assert.equal(d.idempotency_key, antes.idempotency_key);
  assert.equal(d.attempts, 1, 'a tentativa gasta continua contada');
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'"); // a reconciliação rodou num relógio 31 s adiante
  await rodar();
  const fim = await ler(tenant, r.dispatchId);
  assert.equal(fim.status, 'SUBMITTED');
  assert.equal(envios().length, 2);
  assert.equal(new Set(envios().map((c) => c.meta.idempotencyKey)).size, 1, 'as duas submissões levaram a mesma chave');
  assert.equal(Banco.S.todos.length, 1, 'total de pagamentos = 1');
  // Também vale o 404 do banco por chave, e o "não existe" só vale com TODAS as consultas afirmando isso.
  const r2 = await incerto({ semReceber: true });
  Banco.S.consulta404 = true;
  assert.equal((await reconciliar(r2.dispatchId, depois(31))).verdict, 'NOT_FOUND', '404 por chave é "não existe"');
  const r3 = await incerto({ semReceber: true });
  Banco.S.consulta404 = false;
  Banco.S.consultaFalha = erroHttp(503);
  assert.equal((await reconciliar(r3.dispatchId, depois(31))).verdict, 'INCONCLUSIVE', 'consulta que falha nunca vira "não existe"');
  assert.equal((await ler(tenant, r3.dispatchId)).status, 'UNKNOWN');
  // Contradição: o envio já tem id externo e o banco diz que não há registro: nunca repete.
  const r4 = await incerto({ semReceber: true });
  Banco.S.consultaFalha = null;
  await forcar(tenant, r4.dispatchId, "external_resource_id = 'p-externo-1'");
  const c4 = await reconciliar(r4.dispatchId, depois(31));
  assert.equal(c4.verdict, 'INCONCLUSIVE');
  assert.equal((await ler(tenant, r4.dispatchId)).status, 'UNKNOWN');
});

test('unknown_sem_metodo_de_consulta_nunca_repete', async () => {
  // Adapter que não sabe consultar: o envio fica UNKNOWN (inconclusivo), nunca repete.
  delete Banco.prototype.findByIdempotencyKey;
  delete Banco.prototype.findByReference;
  const r = await incerto({ semReceber: true });
  Banco.S.fila('getPaymentStatus', [{ resposta: { status: 'PAID' } }]);
  const rec = await reconciliar(r.dispatchId, depois(31));
  assert.equal(rec.verdict, 'INCONCLUSIVE');
  assert.equal((await ler(tenant, r.dispatchId)).status, 'UNKNOWN');
  assert.equal(envios().length, 1);
});
