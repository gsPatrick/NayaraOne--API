'use strict';

// M9-D046 (critério da M9-D044) — os portões 13 a 16 da esteira abrem contra a tabela REAL ai.release_gates, com as linhas inseridas pelo serviço da API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { QueryTypes } = require('sequelize');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { verificarPortao, ITENS } = require('../../../scripts/ai-ci/lib/portoes');
const K = require('../_helpers/iaPortaoProducao');

let tenantA;
before(async () => { ({ tenantA } = await K.prepararTenants()); await K.carregarPessoas(); });
after(async () => { await K.sequelize.close(); });

test('m9d046_portoes_13_a_16_da_esteira_abrem_contra_a_tabela_real', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await K.limpar(tenantA, tx);
    const consulta = (sql, params) => K.sequelize.query(sql, { bind: params, transaction: tx, type: QueryTypes.SELECT });
    const portoes = Object.entries(ITENS).map(([n, item]) => ({ n: Number(n), item, opcoes: item === 'LAB_VALIDATION' ? { exigeEvidencia: true } : {} }));
    for (const p of portoes) assert.equal((await verificarPortao(consulta, p.item, p.opcoes)).ok, false, `${p.item} sem registro fica vermelho`);
    const p = await K.pessoas(tenantA);
    await K.aprovarGlobais(p.registra, tx);
    await K.aprovar(p.aprova, tx, 'PRODUCTION_APPROVAL');
    for (const g of portoes) {
      const r = await verificarPortao(consulta, g.item, g.opcoes);
      assert.equal(r.ok, true, `${g.item}: ${r.motivo}`);
    }
    // PENDING e REJECTED não abrem; LAB sem evidência não abre (a API exige a evidência para aprovar, então a prova é por SQL).
    await K.service.register(K.ctxAdmin(p.registra), { item: 'RED_TEAM', status: 'REJECTED' }, tx);
    assert.equal((await verificarPortao(consulta, 'RED_TEAM')).ok, false);
    await K.sequelize.query("UPDATE ai.release_gates SET evidence_ref = NULL WHERE item = 'LAB_VALIDATION'", { transaction: tx });
    assert.equal((await verificarPortao(consulta, 'LAB_VALIDATION', { exigeEvidencia: true })).ok, false);
  });
});
