'use strict';

// M9-D019 — decisão humana da proposta: aprovador distinto, snapshot/hash, execução única pelo serviço normal, falha sem
// reexecução, replay do accept, rejeição com motivo e fechamento do tool_call e do run (seção 3 da demanda).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const approval = require('../../../src/features/ai/approval');
const recommendations = require('../../../src/features/ai/recommendations');
const paymentIntents = require('../../../src/features/finance/paymentIntents.service');
const { sequelize, ctxAprovador, lerRec, lerRunDb, lerChamada, contar, q, run, setParam } = require('../_helpers/iaAprovacao');
const { propor, proporOutra, aprovador } = require('../_helpers/iaAprovacaoFluxo');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const intents = (entryId, tx) => contar('finance.payment_intents', 'financial_entry_id = :e', { e: entryId }, tx);
const nega = async (promessa, status, code) => {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `esperava erro ${code}`);
  assert.equal(err.statusCode, status, err.message);
  assert.equal(err.code, code);
  return err;
};

test('m9d019_aprovador_distinto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    const proprio = nega(approval.approveRecommendation(ctxAprovador(tenantA, c.solicitante), id, {}, tx), 403, 'AI_APPROVAL_SELF_BLOCKED');
    const e = await proprio;
    assert.equal(e.message, 'Quem solicitou não pode aprovar a própria proposta.');
    assert.equal((await lerRec(id, tx)).status, 'PENDING');
    assert.equal(await intents(c.entry.id, tx), 0, 'nada foi executado');
    // Outra pessoa aprova e a ação roda uma vez.
    const ok = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(ok.recommendation.status, 'EXECUTED');
    assert.equal(await intents(c.entry.id, tx), 1);
  });
  // Parâmetro Desligado: quem pediu pode decidir.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    await setParam(tenantA, tx, 'ia.aprovacao.aprovador_distinto', false);
    const ok = await approval.approveRecommendation(ctxAprovador(tenantA, c.solicitante), id, {}, tx);
    assert.equal(ok.recommendation.status, 'EXECUTED');
  });
});

test('m9d019_sem_permissao_da_acao_alvo_e_sem_ai_approve', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    const semAcao = ctxAprovador(tenantA, c.aprovador, ['ai:approve', 'ai:read']);
    const e = await nega(approval.approveRecommendation(semAcao, id, {}, tx), 403, 'AI_PERMISSION_DENIED');
    assert.equal(e.message, 'Você não tem permissão para esta ação.');
    await nega(approval.approveRecommendation(ctxAprovador(tenantA, c.aprovador, ['finance:create']), id, {}, tx), 403, 'PERMISSION_DENIED');
    const rec = await lerRec(id, tx);
    assert.equal(rec.status, 'PENDING');
    assert.equal(await intents(c.entry.id, tx), 0);
  });
});

test('m9d019_snapshot_mudou_409_e_vira_stale', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    await run("UPDATE finance.financial_entries SET status = 'PAID' WHERE id = :e", { e: c.entry.id }, tx);
    const out = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(out.stale, true);
    const erro = recommendations.staleError();
    assert.equal(erro.statusCode, 409);
    assert.equal(erro.code, 'AI_PROPOSAL_STALE');
    assert.equal((await lerRec(id, tx)).status, 'STALE');
    assert.equal(await intents(c.entry.id, tx), 0, 'nenhuma intenção criada sobre dado que mudou');
    await nega(approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
  });
});

test('m9d019_allowlist_perdida_ou_argumentos_alterados_viram_stale', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    await run("UPDATE ai.agents SET status = 'RETIRED' WHERE id = :a", { a: c.agent.id }, tx);
    const out = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(out.stale, true);
    assert.equal((await lerRec(id, tx)).status, 'STALE');
    assert.equal(await intents(c.entry.id, tx), 0);
  });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    const outro = await proporOutra(tenantA, tx, c);
    await run("UPDATE ai.ai_recommendations SET proposed_action = jsonb_set(proposed_action, '{args,financialEntryId}', to_jsonb(CAST(:o AS text))) WHERE id = :id", { o: outro.entry.id, id }, tx);
    const out = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(out.stale, true);
    assert.equal(out.integrity, true, 'o argsHash não confere');
    assert.equal(await intents(outro.entry.id, tx), 0);
  });
});

test('m9d019_falha_na_execucao_nao_reexecuta_sozinha', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    // Já existe uma intenção aberta para o lançamento: o serviço normal recusa a segunda.
    await paymentIntents.createPaymentIntent({ financialEntryId: c.entry.id }, c.outro, tx);
    const out = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(out.recommendation.status, 'EXECUTION_FAILED');
    assert.equal(out.outcome, 'EXECUTION_FAILED');
    assert.match(out.outcomeDetail, /FINANCE_PAYMENT_INTENT_ALREADY_OPEN/);
    assert.equal(await intents(c.entry.id, tx), 1, 'só a intenção que já existia: sem meia execução');
    const again = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(again.replayed, true, 'repetir não tenta de novo');
    assert.equal(await intents(c.entry.id, tx), 1);
    await nega(approval.approveRecommendation(ctxAprovador(tenantA, c.outro), id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
    const chamada = await lerChamada(id, tx);
    assert.equal(chamada.status, 'FAILED');
    assert.equal((await lerRunDb(c.runId, tx)).status, 'COMPLETED');
  });
});

test('m9d019_sem_bypass_service_identity_nao_aceita', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    const base = { groupId: tenantA.groupId, companyId: tenantA.companyId, permissions: ['ai:approve', 'finance:create'] };
    await nega(approval.approveRecommendation({ ...base, userId: null, serviceIdentity: true }, id, {}, tx), 403, 'AI_RECOMMENDATION_HUMAN_ONLY');
    await nega(approval.approveRecommendation({ ...base, userId: c.aprovador, actorType: 'NAY' }, id, {}, tx), 403, 'AI_RECOMMENDATION_HUMAN_ONLY');
    await nega(approval.approveRecommendation({ ...base, userId: c.aprovador, serviceIdentity: true }, id, {}, tx), 403, 'AI_RECOMMENDATION_HUMAN_ONLY');
    await nega(approval.rejectRecommendation({ ...base, userId: null, serviceIdentity: true }, id, { reason: 'x' }, tx), 403, 'AI_RECOMMENDATION_HUMAN_ONLY');
    assert.equal((await lerRec(id, tx)).status, 'PENDING');
    assert.equal(await intents(c.entry.id, tx), 0);
  });
});

test('m9d019_execucao_gera_auditoria_e_evento_do_servico', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    const out = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(out.recommendation.status, 'EXECUTED');
    const [intent] = await q('SELECT id, created_by FROM finance.payment_intents WHERE financial_entry_id = :e', { e: c.entry.id }, tx);
    assert.equal(intent.created_by, c.aprovador, 'a autora da intenção é a pessoa que aprovou, não a NAY');
    const auditoria = await q("SELECT user_id AS actor_user_id FROM audit.audit_log WHERE action = 'finance.payment_intent.create' AND entity_id = :i", { i: intent.id }, tx);
    assert.equal(auditoria.length, 1, 'a auditoria do próprio serviço');
    assert.equal(auditoria[0].actor_user_id, c.aprovador);
    const eventoServico = await q("SELECT 1 FROM integration.outbox_events WHERE event_type = 'finance.payment.prepared' AND aggregate_id = :i", { i: intent.id }, tx);
    assert.equal(eventoServico.length, 1, 'o evento do próprio serviço');
    for (const tipo of ['ai.recommendation.accepted']) {
      assert.equal((await q('SELECT 1 FROM integration.outbox_events WHERE event_type = :t AND aggregate_id = :i', { t: tipo, i: id }, tx)).length, 1, tipo);
    }
    assert.equal((await q("SELECT 1 FROM audit.audit_log WHERE action = 'ai.recommendation.outcome' AND entity_id = :i", { i: id }, tx)).length, 1);
    assert.equal((await q("SELECT 1 FROM integration.outbox_events WHERE event_type = 'ai.run.completed' AND aggregate_id = :r", { r: c.runId }, tx)).length, 1);
  });
});
