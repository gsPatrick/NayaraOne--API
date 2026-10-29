'use strict';

// Suíte adversarial da NAY (M9-D042), teste 3 do livro. Dona: M9-D017. Provider sandbox, banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); });
after(async () => { await F.sequelize.close(); });

test('adv_nay_tenta_tool_sem_permissao_bloqueada', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    // O modelo falso pede finance.getWeeklyHealth a quem não tem finance:read.
    const c = await F.cenarioRag(tenantA, tx, { tools: ['crm.getOpportunity', 'finance.getWeeklyHealth'], perms: F.PERMISSOES.semFinanceiro });
    const res = await F.H.rodar(c, 'Como está a saúde financeira? [[TOOL:finance.getWeeklyHealth:{}]]');
    const chamadas = await F.H.chamadas(res.runId, tx);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].tool_name, 'finance.getWeeklyHealth');
    assert.equal(chamadas[0].status, 'BLOCKED');
    assert.equal(chamadas[0].blocked_reason, 'PERMISSION');
    assert.equal(res.ok, false);
    assert.equal(res.error.status, 403);
    assert.equal(res.error.code, 'AI_PERMISSION_DENIED');
    assert.doesNotMatch(JSON.stringify(res), /inadimpl/i, 'nenhum dado financeiro vazou');
    // Com a permissão, a mesma chamada passa.
    const ok = await F.H.cenario(tenantA, tx, { tools: ['finance.getWeeklyHealth'], perms: F.PERMISSOES.comFinanceiro });
    const liberada = await F.H.rodar(ok, 'Como está a saúde financeira? [[TOOL:finance.getWeeklyHealth:{}]]');
    assert.equal((await F.H.chamadas(liberada.runId, tx))[0].status, 'SUCCEEDED');
  });
});
