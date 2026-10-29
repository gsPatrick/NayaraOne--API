'use strict';

// M9-D019 — rejeição com motivo, replay do accept (regra única), fechamento do tool_call e do run pela decisão, e o teste
// adversarial do livro "Tool replay -> idempotência" (replay da tool e do accept).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const approval = require('../../../src/features/ai/approval');
const { createToolCallRecorder } = require('../../../src/features/ai/tools/toolCallRecorder');
const { createProposeAction } = require('../../../src/features/ai/tools/proposals');
const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
const { buildUserContext } = require('../../../src/features/ai/orchestrator/executionContext');
const { partes } = require('../_helpers/iaToolCalls');
const { sequelize, LIMITES, ctxAprovador, lerRec, lerRunDb, lerChamada, contar, q, run, setParam, argsPagamento } = require('../_helpers/iaAprovacao');
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
};
const eventos = (tipo, id, tx) => q('SELECT 1 FROM integration.outbox_events WHERE event_type = :t AND aggregate_id = :i', { t: tipo, i: id }, tx);

test('m9d019_rejeicao_exige_motivo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    await nega(approval.rejectRecommendation(aprovador(tenantA, c), id, {}, tx), 400, 'AI_RECOMMENDATION_INVALID');
    await nega(approval.rejectRecommendation(aprovador(tenantA, c), id, { reason: '   ' }, tx), 400, 'AI_RECOMMENDATION_INVALID');
    assert.equal((await lerRec(id, tx)).status, 'PENDING');
    const ok = await approval.rejectRecommendation(aprovador(tenantA, c), id, { reason: 'Boleto já foi pago por outro meio.' }, tx);
    assert.equal(ok.recommendation.status, 'REJECTED');
    assert.equal(ok.recommendation.decisionReason, 'Boleto já foi pago por outro meio.');
    assert.equal(await intents(c.entry.id, tx), 0, 'nada é executado');
    assert.equal((await eventos('ai.recommendation.rejected', id, tx)).length, 1);
  });
});

test('m9d019_accept_replay_mesmo_decisor_200_e_outro_usuario_409', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    const primeira = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(primeira.replayed, false);
    assert.equal(primeira.outcome, 'EXECUTED');
    // (a) mesmo decisor: devolve o resultado anterior, sem nova execução.
    const replay = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, 'EXECUTED');
    assert.equal(replay.recommendation.id, id);
    assert.equal(await intents(c.entry.id, tx), 1, 'uma única execução');
    assert.equal((await eventos('ai.recommendation.accepted', id, tx)).length, 1);
    // (b) outro usuário com ai:approve numa recomendação já ACCEPTED.
    await nega(approval.approveRecommendation(ctxAprovador(tenantA, c.outro), id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
    // (b) REJECTED e STALE.
    const rej = await proporOutra(tenantA, tx, c);
    await approval.rejectRecommendation(aprovador(tenantA, c), rej.id, { reason: 'não' }, tx);
    await nega(approval.approveRecommendation(aprovador(tenantA, c), rej.id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
    await nega(approval.approveRecommendation(ctxAprovador(tenantA, c.outro), rej.id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
    const velha = await proporOutra(tenantA, tx, c);
    await run("UPDATE finance.financial_entries SET status = 'PAID' WHERE id = :e", { e: velha.entry.id }, tx);
    assert.equal((await approval.approveRecommendation(aprovador(tenantA, c), velha.id, {}, tx)).stale, true);
    await nega(approval.approveRecommendation(aprovador(tenantA, c), velha.id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
    await nega(approval.approveRecommendation(ctxAprovador(tenantA, c.outro), velha.id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
  });
});

test('m9d019_execucao_atualiza_tool_call_e_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, id } = await propor(tenantA, tx);
    const estados = async (proposta, runId) => [(await lerChamada(proposta, tx)), (await lerRunDb(runId, tx))];
    // EXECUTED -> SUCCEEDED e run COMPLETED, com ai.run.completed.
    await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    let [chamada, runDb] = await estados(id, c.runId);
    assert.equal(chamada.status, 'SUCCEEDED');
    assert.equal(runDb.status, 'COMPLETED');
    assert.equal((await eventos('ai.run.completed', c.runId, tx)).length, 1);
    // REJECTED -> CANCELLED_BY_HUMAN e run CANCELLED.
    const rej = await proporOutra(tenantA, tx, c);
    await approval.rejectRecommendation(aprovador(tenantA, c), rej.id, { reason: 'não' }, tx);
    [chamada, runDb] = await estados(rej.id, rej.runId);
    assert.equal(chamada.status, 'CANCELLED_BY_HUMAN');
    assert.equal(runDb.status, 'CANCELLED');
    // STALE -> BLOCKED (STALE) e run CANCELLED.
    const velha = await proporOutra(tenantA, tx, c);
    await run("UPDATE finance.financial_entries SET status = 'PAID' WHERE id = :e", { e: velha.entry.id }, tx);
    await approval.approveRecommendation(aprovador(tenantA, c), velha.id, {}, tx);
    [chamada, runDb] = await estados(velha.id, velha.runId);
    assert.equal(chamada.status, 'BLOCKED');
    assert.equal(chamada.blocked_reason, 'STALE');
    assert.equal(runDb.status, 'CANCELLED');
    assert.equal((await eventos('ai.tool_call.blocked', chamada.id, tx)).length, 1);
    // A mesma decisão repetida não muda nada.
    await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal((await lerChamada(id, tx)).status, 'SUCCEEDED');
  });
});

test('adv_tool_replay_idempotencia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await setParam(tenantA, tx, 'ia.financeira.permitir_proposta_pagamento', true);
    const { cenario } = require('../_helpers/iaAprovacao');
    const c = await cenario(tenantA, tx);
    // Camada da tool: a MESMA chamada (run, seq, argumentos) devolve a proposta anterior, sem criar outra.
    const registry = c.registry;
    const execCtx = buildUserContext({ userId: c.solicitante, groupId: tenantA.groupId, companyId: tenantA.companyId, roles: ['T'], permissions: ['finance:create'] }, { correlationId: 'corr', runId: c.runId });
    const chamar = async () => executeTool({
      registry: registry.executorMap(), toolName: 'finance.proposePayment', input: argsPagamento(c), contextParts: partes(tenantA, { auth: { userId: c.solicitante, permissions: ['finance:create'] } }),
      recorder: createToolCallRecorder({ ctx: { groupId: tenantA.groupId, companyId: tenantA.companyId, userId: c.solicitante }, transaction: tx, runId: c.runId }),
      proposeAction: createProposeAction({ registry, execCtx, agent: c.agent, runId: c.runId, transaction: tx }), argsLimits: LIMITES, transaction: tx, seq: 1,
    });
    const um = await chamar();
    const dois = await chamar();
    assert.equal(um.status, 'PROPOSED');
    assert.equal(dois.proposal.id, um.proposal.id, 'o replay devolve a mesma proposta');
    assert.equal(await contar('ai.ai_recommendations', 'ai_run_id = :r', { r: c.runId }, tx), 1);
    assert.equal(await contar('ai.tool_calls', 'run_id = :r', { r: c.runId }, tx), 1);
    // Camada do accept: duas vezes pelo mesmo decisor = uma execução.
    const id = um.proposal.id;
    await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    const replay = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.equal(replay.replayed, true);
    assert.equal(await intents(c.entry.id, tx), 1);
  });
});
