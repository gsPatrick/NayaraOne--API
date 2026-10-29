'use strict';

// Marco 9, M9-D250 — POST /admin/integrations/errors/:id/retry para erro de ENVIO (HTTP real, MFA real do usuário de teste). Testes 1, 2, 5, 6, 7 e 14 da demanda.
// Roda em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D250_ENVIO_PORT || '21751';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const env = require('../_helpers/m9d250Env');
const { clearCircuitCache } = require('../../../src/features/integrations/health');
const { confirmDispatch } = require('../../../src/features/integrations/dispatch/worker/worker.confirm');

const {
  carregarTenants, conexaoAtiva, limparTudo, enfileirar, pagamento, instalar, restaurar, forcar, ler, dispatch, ctxDe, bancoReconciliavel, comTenant,
} = env;
let tenant;
let banco;
let Banco;
let chamar;
let token;

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
  token = env.tokenDe(tenant, ['integration:read', 'integration:retry']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
beforeEach(async () => {
  Banco = bancoReconciliavel();
  instalar(Banco);
  clearCircuitCache();
  await limparTudo(tenant);
});
after(async () => { restaurar(); await env.sequelize.close(); process.exit(0); });

const pagar = () => enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: crypto.randomUUID(), payload: pagamento() });
const rodar = () => dispatch.runDispatchCycle(ctxDe(tenant), { now: new Date() });
const tentar = (id, body) => chamar(token, 'POST', `/admin/integrations/errors/${id}/retry`, body);
const codigo = (r) => (r.corpo.error ? r.corpo.error.code : null);

/** Pagamento que o banco NÃO recebeu: o pedido se perdeu antes de chegar (UNKNOWN) e a consulta responde "não existe". */
async function perdido() {
  const r = await pagar();
  Banco.S.fila('submitPayment', [{ semReceber: true }]);
  await rodar();
  return r;
}
/** Pagamento que o banco recebeu e cuja resposta se perdeu (UNKNOWN): a consulta acha o pagamento. */
async function recebido() {
  const r = await pagar();
  Banco.S.fila('submitPayment', [{ recebeEDaTimeout: true }]);
  await rodar();
  return r;
}
const comErro = async (r, over = {}) => ({
  ...r, erro: await env.erroDe(tenant, { providerCode: 'bank-sandbox', connectionId: banco.id, source: 'DISPATCH', refId: r.dispatchId, errorCode: 'UNKNOWN_UNRESOLVED', ...over }),
});
const envios = () => Banco.S.chamadas.filter((c) => c.op === 'submitPayment');
const corpoOk = { reason: 'Conferi o extrato do banco.', confirmDangerous: true };

test('retry_perigoso_exige_mfa_confirmacao_e_reconciliacao', async () => {
  const r = await comErro(await perdido());
  assert.equal((await ler(tenant, r.dispatchId)).status, 'UNKNOWN');
  await env.ativarMfa(tenant);
  await env.vencerMfa(tenant);
  const semMfa = await tentar(r.erro.id, corpoOk);
  assert.equal(semMfa.status, 403);
  assert.equal(codigo(semMfa), 'MFA_STEP_UP_REQUIRED', 'operação perigosa sem MFA recente');
  assert.equal(Banco.S.consultas.length, 0, 'sem MFA nada é consultado');

  await env.ativarMfa(tenant);
  const ok = await tentar(r.erro.id, corpoOk);
  assert.equal(ok.status, 202);
  assert.deepEqual(ok.corpo.data, { errorId: r.erro.id, status: 'RETRYING', dispatchId: r.dispatchId });
  assert.ok(Banco.S.consultas.length >= 1, 'a reconciliação (D215) consultou o banco antes de repetir');
  const d = await ler(tenant, r.dispatchId);
  assert.equal(d.status, 'RETRY_WAIT', 'o banco respondeu "não existe": o mesmo envio volta à fila');
  assert.equal(d.idempotency_key, (await ler(tenant, r.dispatchId)).idempotency_key);
  assert.equal((await env.erroLinha(tenant, r.erro.id)).status, 'RETRYING');
  // O worker repete UMA vez, com a mesma chave: o banco fica com um único pagamento.
  Banco.S.fila('submitPayment', [{}]);
  await rodar();
  assert.equal(envios().length, 2, 'uma ordem perdida e uma repetida');
  assert.equal(new Set(envios().map((c) => c.meta.idempotencyKey)).size, 1, 'sempre a mesma chave de idempotência');
  assert.equal(Banco.S.todos.length, 1, 'um único pagamento no banco');
});

test('retry_perigoso_reconciliacao_acha_pagamento_nao_repete', async () => {
  const r = await comErro(await recebido());
  await env.ativarMfa(tenant);
  const antes = envios().length;
  const res = await tentar(r.erro.id, corpoOk);
  assert.equal(res.status, 409);
  assert.equal(codigo(res), 'INTEGRATION_RETRY_NOT_ALLOWED', 'o fornecedor já tem o pagamento: não repete');
  assert.equal(envios().length, antes, 'nenhuma nova ordem');
  assert.equal((await ler(tenant, r.dispatchId)).status, 'SUBMITTED', 'a descoberta da reconciliação foi gravada');
  assert.equal((await env.erroLinha(tenant, r.erro.id)).status, 'OPEN');
});

test('retry_perigoso_sem_confirmacao_recusado', async () => {
  const r = await comErro(await perdido());
  await env.ativarMfa(tenant);
  const res = await tentar(r.erro.id, { reason: 'Conferi o extrato.' });
  assert.equal(res.status, 409);
  assert.equal(codigo(res), 'INTEGRATION_RETRY_NOT_ALLOWED');
  const falso = await tentar(r.erro.id, { reason: 'Conferi o extrato.', confirmDangerous: false });
  assert.equal(codigo(falso), 'INTEGRATION_RETRY_NOT_ALLOWED');
  assert.equal((await ler(tenant, r.dispatchId)).status, 'UNKNOWN', 'nada mudou');
  assert.equal(Banco.S.consultas.length, 0, 'sem confirmação nem consulta');
  const tipo = await tentar(r.erro.id, { reason: 'Conferi o extrato.', confirmDangerous: 'sim' });
  assert.equal(tipo.status, 422);
});

test('retry_dead_letter_dangerous_move_para_retry_wait_com_mais_3_tentativas', async () => {
  const r = await comErro(await perdido());
  await forcar(tenant, r.dispatchId, "status = 'DEAD_LETTER', dead_letter_reason = 'UNKNOWN_UNRESOLVED', unknown_since = NULL, next_attempt_at = NULL");
  const antes = await ler(tenant, r.dispatchId);
  await env.ativarMfa(tenant);
  await env.vencerMfa(tenant);
  assert.equal(codigo(await tentar(r.erro.id, corpoOk)), 'MFA_STEP_UP_REQUIRED', 'sem MFA: 403');
  await env.ativarMfa(tenant);
  assert.equal(codigo(await tentar(r.erro.id, { reason: 'Conferi o extrato.' })), 'INTEGRATION_RETRY_NOT_ALLOWED', 'sem confirmação: 409');
  assert.equal((await ler(tenant, r.dispatchId)).status, 'DEAD_LETTER');
  const ok = await tentar(r.erro.id, corpoOk);
  assert.equal(ok.status, 202);
  const d = await ler(tenant, r.dispatchId);
  assert.equal(d.status, 'RETRY_WAIT');
  assert.equal(d.attempts, antes.attempts, 'attempts mantido');
  assert.equal(d.max_attempts, antes.max_attempts + 3, '+3 tentativas concedidas');
  assert.equal(d.idempotency_key, antes.idempotency_key, 'a mesma chave');
  assert.equal(d.payload_hash, antes.payload_hash, 'o mesmo hash');
  assert.equal(d.dead_letter_reason, null);
});

test('retry_idempotente_em_retrying', async () => {
  const r = await comErro(await perdido());
  await env.ativarMfa(tenant);
  const a = await tentar(r.erro.id, corpoOk);
  const b = await tentar(r.erro.id, corpoOk);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.deepEqual(b.corpo.data, a.corpo.data, 'a mesma resposta');
  const d = await ler(tenant, r.dispatchId);
  assert.equal(d.status, 'RETRY_WAIT');
  assert.equal((await env.trilha(tenant, r.erro.id, 'integration.error.retry_requested')).length, 1, 'o segundo pedido não audita nem mexe de novo');
});

test('retry_concorrente_um_vence', async () => {
  const r = await comErro(await perdido());
  await forcar(tenant, r.dispatchId, "status = 'DEAD_LETTER', dead_letter_reason = 'UNKNOWN_UNRESOLVED', unknown_since = NULL, next_attempt_at = NULL");
  const antes = await ler(tenant, r.dispatchId);
  await env.ativarMfa(tenant);
  const [a, b] = await Promise.all([tentar(r.erro.id, corpoOk), tentar(r.erro.id, corpoOk)]);
  assert.deepEqual([a.status, b.status], [202, 202], 'um vence, o outro recebe o estado atual');
  assert.deepEqual(a.corpo.data, b.corpo.data);
  const d = await ler(tenant, r.dispatchId);
  assert.equal(d.max_attempts, antes.max_attempts + 3, 'as 3 tentativas foram concedidas uma única vez');
  assert.equal((await env.trilha(tenant, r.erro.id, 'integration.error.retry_requested')).length, 1);
});

test('retry_auditoria_com_motivo_e_aprovador', async () => {
  const r = await comErro(await perdido());
  await env.ativarMfa(tenant);
  assert.equal(codigo(await tentar(r.erro.id, { confirmDangerous: true })), 'INTEGRATION_RETRY_REASON_REQUIRED', 'sem motivo: 422');
  assert.equal((await tentar(r.erro.id, { reason: 'ab', confirmDangerous: true })).status, 422, 'motivo curto demais');
  assert.equal((await tentar(r.erro.id, { reason: 'x'.repeat(501), confirmDangerous: true })).status, 422, 'motivo longo demais');
  assert.equal((await env.trilha(tenant, r.erro.id, 'integration.error.retry_requested')).length, 0, 'recusa não audita');
  assert.equal((await tentar(r.erro.id, corpoOk)).status, 202);
  const [linha] = await env.trilha(tenant, r.erro.id, 'integration.error.retry_requested');
  assert.match(linha.reason, /Conferi o extrato do banco/);
  assert.equal(linha.user_id, tenant.userId);
  assert.equal(linha.before_json.status, 'OPEN');
  assert.equal(linha.after_json.status, 'RETRYING');
  assert.equal(linha.after_json.approvedBy, tenant.userId, 'o aprovador da operação perigosa');
  assert.equal(linha.after_json.target.dispatchId, r.dispatchId);
  const doEnvio = (await env.trilha(tenant, r.dispatchId, 'integration.dispatch.status_changed')).pop();
  assert.match(doEnvio.reason, /Conferi o extrato do banco/, 'o motivo também entra na trilha do envio');
});

test('retry_envio_seguro_nao_exige_mfa_e_confirmado_e_recusado', async () => {
  const msg = await env.conexaoAtiva(tenant, 'MESSAGING');
  const seguro = await enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Msg', aggregateId: crypto.randomUUID(), payload: { to: '+5511999990000', text: 'oi' } });
  await forcar(tenant, seguro.dispatchId, "status = 'FAILED', last_error_class = 'TRANSIENT'");
  const e1 = await env.erroDe(tenant, { providerCode: msg.providerCode, connectionId: msg.id, source: 'DISPATCH', refId: seguro.dispatchId, errorClass: 'TRANSIENT', errorCode: 'QA_M9_D250_SEGURO' });
  await env.vencerMfa(tenant);
  const ok = await tentar(e1.id, { reason: 'Tentar de novo.' });
  assert.equal(ok.status, 202, 'operação segura: sem MFA e sem confirmação');
  assert.equal((await ler(tenant, seguro.dispatchId)).status, 'RETRY_WAIT');

  const r = await comErro(await perdido(), { errorCode: 'QA_M9_D250_CONFIRMADO' });
  await forcar(tenant, r.dispatchId, "status = 'CONFIRMED', confirmed_at = now()");
  await env.ativarMfa(tenant);
  const conf = await tentar(r.erro.id, corpoOk);
  assert.equal(conf.status, 409);
  assert.equal(codigo(conf), 'INTEGRATION_DISPATCH_ALREADY_CONFIRMED', 'envio confirmado nunca repete');
  assert.equal(codigo(await tentar(crypto.randomUUID(), corpoOk)), 'INTEGRATION_ERROR_NOT_FOUND');
  const semPerm = await chamar(env.tokenDe(tenant, ['integration:read']), 'POST', `/admin/integrations/errors/${r.erro.id}/retry`, corpoOk);
  assert.equal(semPerm.status, 403);
  assert.equal(codigo(semPerm), 'PERMISSION_DENIED');
  if (env.carregarTenants) {
    const { outro } = await carregarTenants();
    if (outro) assert.equal((await chamar(env.tokenDe(outro, ['integration:retry']), 'POST', `/admin/integrations/errors/${r.erro.id}/retry`, corpoOk)).status, 404, 'erro de outra empresa não existe');
  }
});

test('retry_fecha_o_ciclo_do_erro_com_o_desfecho_do_envio', async () => {
  await env.ativarMfa(tenant);
  const ctx = ctxDe(tenant);
  // Repetição que dá certo: o erro RETRYING vai a RESOLVED sem autor.
  const a = await comErro(await perdido(), { errorCode: 'QA_M9_D250_FECHA_A' });
  assert.equal((await tentar(a.erro.id, corpoOk)).status, 202);
  assert.equal((await env.erroLinha(tenant, a.erro.id)).status, 'RETRYING');
  await forcar(tenant, a.dispatchId, "status = 'SUBMITTED'");
  await comTenant(tenant, (t) => confirmDispatch(ctx, a.dispatchId, { source: 'STATUS_QUERY', status: 'PAID' }, t));
  const fechado = await env.erroLinha(tenant, a.erro.id);
  assert.equal(fechado.status, 'RESOLVED');
  assert.equal(fechado.resolved_by, null);
  assert.match(fechado.resolution_note, /confirmado/);
  // Repetição que volta a ficar incerta: o erro RETRYING volta a OPEN.
  const b = await comErro(await perdido(), { errorCode: 'QA_M9_D250_FECHA_B' });
  assert.equal((await tentar(b.erro.id, corpoOk)).status, 202);
  await comTenant(tenant, async (t) => {
    await dispatch.transitionDispatch(ctx, b.dispatchId, 'SENDING', {}, {}, t);
    await dispatch.transitionDispatch(ctx, b.dispatchId, 'UNKNOWN', {}, {}, t);
  });
  assert.equal((await env.erroLinha(tenant, b.erro.id)).status, 'OPEN', 'a repetição não resolveu: o erro reabre');
});
