'use strict';

// Suíte adversarial da NAY (M9-D042), teste 8 do livro. Dona: M9-D014. Banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const { rejeita } = require('../../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); });
after(async () => { await F.sequelize.close(); });

test('adv_budget_estoura_politica_de_degradacao', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    // Não crítico a 90%: só regra, cache e modelo pequeno.
    const nc = await F.orcamentoProgramavel(tenantA, tx);
    await nc.consumirAte(181);
    await rejeita(nc.tentar('ADVANCED_MODEL'), 429, 'AI_BUDGET_EXHAUSTED');
    for (const caminho of ['RULE', 'CACHE', 'SMALL_MODEL']) assert.ok(await nc.tentar(caminho), `${caminho} a 90%`);
    // Não crítico a 100%: 429 em tudo que gasta (a regra de custo zero segue).
    await nc.consumirAte(200);
    for (const caminho of ['SMALL_MODEL', 'ADVANCED_MODEL', 'CACHE']) await rejeita(nc.tentar(caminho), 429, 'AI_BUDGET_EXHAUSTED');
    assert.ok(await nc.tentar('RULE'));
    // Crítico a 100%: regra, cache e pequeno seguem; a tarefa que exige avançado recebe 429.
    const critico = await F.orcamentoProgramavel(tenantA, tx);
    await critico.consumirAte(200);
    for (const caminho of ['RULE', 'CACHE', 'SMALL_MODEL']) assert.ok(await critico.tentar(caminho, { criticality: 'CRITICAL' }), `${caminho} crítico a 100%`);
    const err = await rejeita(critico.tentar('ADVANCED_MODEL', { criticality: 'CRITICAL' }), 429, 'AI_BUDGET_EXHAUSTED');
    assert.equal(err.details.state, 'EXHAUSTED');
  });
});
