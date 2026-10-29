'use strict';

// Marco 9, M9-D214 — worker: SENDING com commit antes da chamada, ids externos, 202 não confirma, evento único, circuito aberto.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, pagamento, tentativas, eventos, instalar, restaurar, forcar, ler, dispatch,
} = require('../_helpers/m9d214Env');
const { bancoProgramavel, mensagemProgramavel } = require('../_helpers/m9d214Scripted');
const { updateCircuitState, clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let banco;
let msg;
let Banco;
let Msg;
const agg = () => crypto.randomUUID();

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
  msg = await conexaoAtiva(tenant, 'MESSAGING');
  Banco = bancoProgramavel();
  Msg = mensagemProgramavel();
  instalar(Banco);
  instalar(Msg);
});
beforeEach(async () => { Banco.S.reset(); Msg.S.reset(); clearCircuitCache(); await limparPendentes(tenant); });
after(async () => { restaurar(); await sequelize.close(); });

const ctx = () => ctxDe(tenant);
const pedirPagamento = (extra = {}) => enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento(), ...extra });
const pedirTexto = (extra = {}) => enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990000', text: 'Olá' }, ...extra });
const rodar = () => dispatch.runDispatchCycle(ctx());

test('dispatch_sending_commit_antes_da_chamada', async () => {
  const r = await pedirPagamento();
  let visto = null;
  Banco.S.aoChamar = async () => { visto = await ler(tenant, r.dispatchId); };
  Banco.S.fila('submitPayment', [{ resposta: { status: 'PENDING', externalResourceId: 'p-77' } }]);
  const resumo = await rodar();
  assert.equal(resumo.sent, 1);
  assert.equal(visto.status, 'SENDING', 'no instante da chamada outra sessão já vê SENDING (commit antes)');
  assert.equal(visto.attempts, 1);
  // Queda depois do SENDING: o processo morreu antes de qualquer resposta; o rastro fica e o recuperador manda para UNKNOWN.
  const queda = await pedirPagamento();
  await comTenant(tenant, async (t) => { await dispatch.claimDue(ctx(), 5, t); });
  const preso = await ler(tenant, queda.dispatchId);
  assert.equal(preso.status, 'SENDING', 'a queda deixa o envio em SENDING com a tentativa contada');
  assert.equal(preso.attempts, 1);
  await forcar(tenant, queda.dispatchId, "updated_at = now() - interval '10 minutes'");
  const recuperados = await comTenant(tenant, (t) => dispatch.recoverStaleSending(ctx(), t));
  assert.deepEqual(recuperados.map((d) => [d.id, d.status]), [[queda.dispatchId, 'UNKNOWN']]);
});

test('dispatch_202_nao_confirma_pagamento', async () => {
  const r = await pedirPagamento();
  Banco.S.fila('submitPayment', [{ resposta: { status: 'ACCEPTED', externalResourceId: 'p-77', externalRequestId: 'rq-9' } }]);
  await rodar();
  const linha = await ler(tenant, r.dispatchId);
  assert.equal(linha.status, 'SUBMITTED', 'o banco aceitou a ordem: SUBMITTED, nunca CONFIRMED');
  assert.equal(linha.confirmed_at, null);
  assert.equal(linha.external_status, 'ACCEPTED');
  assert.ok(linha.submitted_at);
  assert.equal((await eventos(tenant, dispatch.EVENTS.CONFIRMED, r.dispatchId)).length, 0, 'sem evento de confirmação');
  // A resposta de submissão não vale como evidência de uma operação ON_STATUS.
  await assert.rejects(comTenant(tenant, (t) => dispatch.confirmDispatch(ctx(), r.dispatchId, { source: 'RESPONSE', status: 'PAID' }, t)), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_CONFIRMATION_EVIDENCE_REQUIRED');
  await assert.rejects(comTenant(tenant, (t) => dispatch.confirmDispatch(ctx(), r.dispatchId, { source: 'palpite' }, t)), (e) => e.code === 'INTEGRATION_CONFIRMATION_EVIDENCE_INVALID');
  // Webhook assinado com o status final (40 s depois, no exemplo do livro): CONFIRMED.
  const ok = await comTenant(tenant, (t) => dispatch.confirmDispatch(ctx(), r.dispatchId, { source: 'WEBHOOK_SIGNED', status: 'PAID', externalResourceId: 'p-77' }, t));
  assert.equal(ok.confirmed, true);
  const depois = await ler(tenant, r.dispatchId);
  assert.equal(depois.status, 'CONFIRMED');
  assert.ok(depois.confirmed_at);
  // Consulta que traz o status final também vale (STATUS_QUERY), em outro envio.
  const outro = await pedirPagamento();
  Banco.S.fila('submitPayment', [{ resposta: { status: 'ACCEPTED', externalResourceId: 'p-78' } }]);
  await rodar();
  await comTenant(tenant, (t) => dispatch.confirmDispatch(ctx(), outro.dispatchId, { source: 'STATUS_QUERY', status: 'PAID' }, t));
  assert.equal((await ler(tenant, outro.dispatchId)).status, 'CONFIRMED');
});

test('dispatch_confirmacao_publica_evento_uma_vez', async () => {
  const r = await pedirPagamento();
  Banco.S.fila('submitPayment', [{ resposta: { status: 'ACCEPTED', externalResourceId: 'p-90' } }]);
  await rodar();
  const [a, b] = await Promise.all([1, 2].map(() => comTenant(tenant, (t) => dispatch.confirmDispatch(ctx(), r.dispatchId, { source: 'WEBHOOK_SIGNED', status: 'PAID' }, t))));
  assert.deepEqual([a.confirmed, b.confirmed].sort(), [false, true], 'só uma das confirmações simultâneas confirma');
  const ev = await eventos(tenant, dispatch.EVENTS.CONFIRMED, r.dispatchId);
  assert.equal(ev.length, 1, 'um evento só, mesmo confirmando duas vezes');
  assert.equal(ev[0].aggregate_type, 'PaymentIntent');
  assert.equal(ev[0].payload_json.dispatchId, r.dispatchId);
  assert.equal(ev[0].payload_json.externalResourceId, 'p-90');
  assert.equal(ev[0].target_domain, null, 'é evento interno: o domínio reage a ele');
  // ON_RESPONSE com evidência (mensagem entregue): o próprio worker confirma, também uma vez.
  const m = await pedirTexto();
  Msg.S.fila('sendText', [{ resposta: { status: 'DELIVERED', externalResourceId: 'm-1' } }]);
  await rodar();
  assert.equal((await ler(tenant, m.dispatchId)).status, 'CONFIRMED');
  assert.equal((await eventos(tenant, dispatch.EVENTS.CONFIRMED, m.dispatchId)).length, 1);
  // Mensagem só aceita pela fila do fornecedor (SENT) fica SUBMITTED.
  const n = await pedirTexto({ payload: { to: '+5541999990001', text: 'Oi' } });
  Msg.S.fila('sendText', [{ resposta: { status: 'SENT', externalResourceId: 'm-2' } }]);
  await rodar();
  assert.equal((await ler(tenant, n.dispatchId)).status, 'SUBMITTED');
});

test('dispatch_grava_external_request_id_e_external_resource_id', async () => {
  const r = await pedirTexto({ payload: { to: '+5541999990002', text: 'Teste' } });
  Msg.S.fila('sendText', [{ resposta: { status: 'SENT', externalRequestId: 'req-abc', externalResourceId: 'res-xyz' } }]);
  await rodar();
  const linha = await ler(tenant, r.dispatchId);
  assert.equal(linha.external_request_id, 'req-abc');
  assert.equal(linha.external_resource_id, 'res-xyz');
  assert.equal(linha.status, 'SUBMITTED');
  const tent = await tentativas(tenant, r.dispatchId);
  assert.equal(tent.length, 1);
  assert.equal(tent[0].outcome, 'SUCCESS');
  assert.equal(tent[0].attempt_no, 1);
  assert.ok(tent[0].latency_ms >= 0);
  assert.equal(Msg.S.chamadas[0].meta.dispatchId, r.dispatchId);
  assert.equal(Msg.S.chamadas[0].meta.idempotencyKey, undefined, 'adapter sem suporte a idempotência não recebe a chave');
});

test('dispatch_chave_vai_ao_fornecedor_quando_ha_suporte', async () => {
  const Com = bancoProgramavel({ idempotente: true });
  instalar(Com);
  try {
    const r = await pedirPagamento();
    await rodar();
    const linha = await ler(tenant, r.dispatchId);
    assert.equal(Com.S.chamadas[0].meta.idempotencyKey, linha.idempotency_key, 'a chave estável segue ao fornecedor que a aceita');
    assert.deepEqual(Com.S.chamadas[0].request, linha.payload_snapshot, 'e o fornecedor recebe exatamente o snapshot aprovado');
  } finally { instalar(Banco); }
});

test('dispatch_circuito_aberto_nao_conta_tentativa', async () => {
  const r = await pedirPagamento();
  const essencial = await pedirPagamento({ essential: true });
  await comTenant(tenant, (t) => updateCircuitState(banco.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 120 }, t));
  const resumo = await rodar();
  assert.equal(resumo.deferred, 1, 'o não essencial espera');
  const espera = await ler(tenant, r.dispatchId);
  assert.equal(espera.status, 'RETRY_WAIT');
  assert.equal(espera.attempts, 0, 'a espera não gasta tentativa');
  const ate = new Date(espera.next_attempt_at).getTime() - Date.now();
  assert.ok(ate > 100000 && ate <= 121000, `espera até o fim do cooldown (${ate} ms)`);
  assert.equal((await tentativas(tenant, r.dispatchId)).length, 0, 'nenhuma chamada foi aberta');
  assert.equal((await ler(tenant, essencial.dispatchId)).status, 'SUBMITTED', 'a operação essencial atravessa o circuito aberto');
  assert.equal(Banco.S.chamadas.length, 1);
  // Passado o cooldown o envio segue e a primeira tentativa de verdade é a 1.
  await comTenant(tenant, (t) => updateCircuitState(banco.id, { circuitOpenedAt: new Date(Date.now() - 130000) }, t));
  clearCircuitCache();
  await forcar(tenant, r.dispatchId, 'next_attempt_at = now()');
  await rodar();
  const feito = await ler(tenant, r.dispatchId);
  assert.equal(feito.status, 'SUBMITTED');
  assert.equal(feito.attempts, 1);
  await comTenant(tenant, (t) => updateCircuitState(banco.id, { circuitState: 'CLOSED', circuitOpenedAt: null, circuitCooldownS: null }, t));
});

test('dispatch_conexao_parada_espera_sem_gastar_tentativa', async () => {
  const r = await pedirPagamento();
  await forcar(tenant, r.dispatchId, "status = 'PENDING'");
  await comTenant(tenant, (t) => sequelize.query("UPDATE integration.connections SET status = 'PAUSED' WHERE id = :id", { replacements: { id: banco.id }, transaction: t }));
  try {
    await rodar();
    const espera = await ler(tenant, r.dispatchId);
    assert.equal(espera.status, 'RETRY_WAIT');
    assert.equal(espera.attempts, 0);
    assert.equal(Banco.S.chamadas.length, 0, 'conexão pausada: nenhuma chamada');
  } finally {
    await comTenant(tenant, (t) => sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { replacements: { id: banco.id }, transaction: t }));
  }
});
