'use strict';

// Suíte adversarial da NAY (M9-D042), teste 15 do livro. Dona: M9-D019. Em série e em 2 conexões; banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const approval = require('../../../../src/features/ai/approval');
const { createToolCallRecorder } = require('../../../../src/features/ai/tools/toolCallRecorder');
const { createProposeAction } = require('../../../../src/features/ai/tools/proposals');
const { executeTool } = require('../../../../src/features/ai/tools/toolExecutor');
const { buildUserContext } = require('../../../../src/features/ai/orchestrator/executionContext');
const { partes } = require('../../_helpers/iaToolCalls');
const { LIMITES, ctxAprovador, contar, setParam, argsPagamento, cenario } = require('../../_helpers/iaAprovacao');
const { aprovador, propor } = require('../../_helpers/iaAprovacaoFluxo');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); });
after(async () => {
  await comoTenant((tx) => setParam(tenantA, tx, 'ia.financeira.permitir_proposta_pagamento', false)); // o parâmetro da parte em 2 conexões foi COMMITADO
  await F.sequelize.close();
});

/** Uma conexão própria, com a empresa na sessão, que grava de verdade (a parte de 2 conexões não pode ficar em um rollback só). */
function comoTenant(fn) {
  return F.sequelize.transaction(async (transaction) => {
    await F.sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await F.sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    await F.sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantA.userId }, transaction });
    return fn(transaction);
  });
}

test('adv_tool_replay_idempotencia', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    await setParam(tenantA, tx, 'ia.financeira.permitir_proposta_pagamento', true);
    const c = await cenario(tenantA, tx);
    const execCtx = buildUserContext({ userId: c.solicitante, groupId: tenantA.groupId, companyId: tenantA.companyId, roles: ['T'], permissions: ['finance:create'] }, { correlationId: 'corr', runId: c.runId });
    const chamar = () => executeTool({
      registry: c.registry.executorMap(), toolName: 'finance.proposePayment', input: argsPagamento(c), contextParts: partes(tenantA, { auth: { userId: c.solicitante, permissions: ['finance:create'] } }),
      recorder: createToolCallRecorder({ ctx: { groupId: tenantA.groupId, companyId: tenantA.companyId, userId: c.solicitante }, transaction: tx, runId: c.runId }),
      proposeAction: createProposeAction({ registry: c.registry, execCtx, agent: c.agent, runId: c.runId, transaction: tx }), argsLimits: LIMITES, transaction: tx, seq: 1,
    });
    // Mesma tool call repetida: uma proposta e um tool_call só.
    const um = await chamar();
    const dois = await chamar();
    assert.equal(dois.proposal.id, um.proposal.id, 'o replay devolve a mesma proposta');
    assert.equal(await contar('ai.ai_recommendations', 'ai_run_id = :r', { r: c.runId }, tx), 1);
    assert.equal(await contar('ai.tool_calls', 'run_id = :r', { r: c.runId }, tx), 1);
    // Mesmo accept repetido: uma execução; o segundo devolve replayed=true.
    const id = um.proposal.id;
    const primeiro = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    const segundo = await approval.approveRecommendation(aprovador(tenantA, c), id, {}, tx);
    assert.notEqual(primeiro.replayed, true);
    assert.equal(segundo.replayed, true);
    assert.equal(await contar('finance.payment_intents', 'financial_entry_id = :e', { e: c.entry.id }, tx), 1);
  });
  // Em 2 conexões ao mesmo tempo: o mesmo accept três vezes (mesmo decisor) vale uma execução; as outras viram replay.
  assert.equal(process.env.DISPOSABLE_DB, '1', 'a parte de 2 conexões grava de verdade: roda só no banco descartável (npm run test:ai:adversarial)');
  const { c: p, id: propostaId } = await comoTenant((tx) => propor(tenantA, tx));
  const ctx = ctxAprovador(tenantA, p.aprovador);
  const resultados = await Promise.allSettled([1, 2, 3].map(() => comoTenant((tx) => approval.approveRecommendation(ctx, propostaId, {}, tx))));
  const feitos = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.equal(resultados.length, feitos.length, JSON.stringify(resultados.filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.code)));
  assert.equal(feitos.filter((r) => r.replayed === false).length, 1, 'uma única execução');
  assert.equal(feitos.filter((r) => r.replayed === true).length, 2, 'as outras duas devolvem replayed=true');
  assert.equal(await comoTenant((tx) => contar('finance.payment_intents', 'financial_entry_id = :e', { e: p.entry.id }, tx)), 1);
});
