'use strict';

// M9-D012 — orçamento na decisão: o estado real do orçamento (D014) limita os caminhos; 429 AI_BUDGET_EXHAUSTED e 403 sem orçamento.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const budgets = require('../../../src/features/ai/budgets');
const { novoRoteador, entrada, tenantCtx } = require('../_helpers/iaRouter');
const P = require('../_helpers/iaProviders');
const H = require('../_helpers/iaAvaliacao');
const O = require('../_helpers/iaOrcamento');

let tenantA;
before(async () => {
  ({ tenantA } = await prepararTenants());
  await H.carregarPessoas();
  await P.prepararAmbiente(tenantA);
});
after(async () => { await sequelize.close(); });

const estado = (tx, agente, criticality = 'NON_CRITICAL') => budgets.budgetState(tenantCtx(tenantA), { agentCode: agente, criticality, at: O.AGORA }, tx);
const decidir = async (router, tx, agente, taskType, criticality = 'NON_CRITICAL') => router.decide(
  entrada({ agentCode: agente, criticality, taskType, budgetState: await estado(tx, agente, criticality) }), tenantCtx(tenantA), tx
);

test('m9d012_orcamento_entra_na_decisao_por_estado_real', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    const agente = O.agente();
    const ctx = tenantCtx(tenantA);
    // Sem orçamento: modelo é 403; regra continua passando.
    assert.equal((await estado(tx, agente)).configured, false);
    await P.recusa(decidir(router, tx, agente, 'classificar'), 'AI_BUDGET_NOT_CONFIGURED', 403);
    const b = await O.criarOrcamento(ctx, tx, { agentCode: agente, limit: '100.00' });
    assert.equal((await decidir(router, tx, agente, 'comparar_documentos')).path, 'ADVANCED_MODEL');
    // 90%: não crítico só RULE, CACHE e pequeno; o avançado é 429.
    await tx.sequelize.query("UPDATE ai.budgets SET consumed_amount = '90.000000' WHERE id = :id", { replacements: { id: b.id }, transaction: tx });
    assert.equal((await estado(tx, agente)).state, 'DEGRADED');
    assert.equal((await decidir(router, tx, agente, 'classificar')).path, 'SMALL_MODEL');
    await P.recusa(decidir(router, tx, agente, 'comparar_documentos'), 'AI_BUDGET_EXHAUSTED', 429);
    // 100%: não crítico (ação BLOCK) só regra; o pequeno também é 429. Crítico segue no pequeno e o avançado é 429.
    await tx.sequelize.query("UPDATE ai.budgets SET consumed_amount = '100.000000' WHERE id = :id", { replacements: { id: b.id }, transaction: tx });
    await P.recusa(decidir(router, tx, agente, 'classificar'), 'AI_BUDGET_EXHAUSTED', 429);
    assert.equal((await decidir(router, tx, agente, 'classificar', 'CRITICAL')).path, 'SMALL_MODEL');
    await P.recusa(decidir(router, tx, agente, 'comparar_documentos', 'CRITICAL'), 'AI_BUDGET_EXHAUSTED', 429);
    assert.equal((await decidir(router, tx, agente, 'calcular_total')).path, 'RULE');
  });
});
