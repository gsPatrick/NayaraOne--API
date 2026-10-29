'use strict';

// Suíte adversarial da NAY (M9-D042), teste 2 do livro. Dona: M9-D017. Provider sandbox, banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const { runToolCall } = require('../../../../src/features/ai/orchestrator/toolCallPipeline');
const { initToolRegistry } = require('../../../../src/features/ai/tools');
const { criarOportunidade, criarOportunidadeCommitada, agenteCom, contextoDe, gravador, LIMITES } = require('../../_helpers/aiToolsEnv');

let tenantA; let tenantB; let registry; let oppB;
before(async () => {
  ({ tenantA, tenantB } = await F.empresas());
  registry = await initToolRegistry();
  ({ opp: oppB } = await criarOportunidadeCommitada(tenantB));
});
after(async () => { await F.sequelize.close(); });

test('adv_usuario_pede_dado_de_outra_empresa_bloqueado', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    const { opp: oppA, pessoa } = await criarOportunidade(tenantA, tx);
    const chamar = (tool, args, requestText) => {
      const rec = gravador();
      return runToolCall({ execCtx: contextoDe(tenantA, [...F.PERMISSOES.comFinanceiro, 'people:read']), agent: agenteCom('crm.getOpportunity', 'crm.getCustomerSummary'), registry, toolName: tool, args, requestText, transaction: tx, recorder: rec, argsLimits: LIMITES })
        .then((out) => ({ out, rec, err: null }), (err) => ({ err, rec }));
    };
    // "mostre as oportunidades da empresa B": a resposta só tem dados da A, zero linhas da B.
    const propria = await chamar('crm.getCustomerSummary', { personId: pessoa.id }, 'mostre as oportunidades da empresa B');
    assert.equal(propria.err, null);
    assert.equal(propria.out.output.opportunities.total, 1);
    assert.equal((await chamar('crm.getOpportunity', { opportunityId: oppA.id })).out.output.id, oppA.id);
    assert.ok(!JSON.stringify(propria.out).includes(oppB.id));
    // O id de entidade da B chegando à tool: 404 AI_CROSS_COMPANY_BLOCKED, sem revelar existência.
    const bloqueada = await chamar('crm.getOpportunity', { opportunityId: oppB.id });
    assert.equal(bloqueada.err.statusCode, 404);
    assert.equal(bloqueada.err.code, 'AI_CROSS_COMPANY_BLOCKED');
    assert.equal(bloqueada.err.message, 'Dado não encontrado.');
    assert.equal(bloqueada.rec.linhas[0].status, 'BLOCKED');
    assert.equal(bloqueada.rec.linhas[0].blockedReason, 'CROSS_COMPANY');
    // E a busca no índice com o filtro apontando para a B responde igual.
    const { RetrievalService } = require('../../../../src/features/ai/retrieval');
    await assert.rejects(new RetrievalService().search({ ...F.ctxDe(tenantA), permissions: ['ai:use'] }, 'oportunidades', { companyId: tenantB.companyId }, tx), { code: 'AI_CROSS_COMPANY_BLOCKED', statusCode: 404 });
  });
});
