'use strict';

// Suíte adversarial da NAY (M9-D042), teste 12 do livro. Dona: M9-D026. Modelo falso inventa o valor; banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const numbers = require('../../../../src/features/ai/orchestrator/numbers');
const { validateGrounding } = require('../../../../src/features/ai/orchestrator/grounding');
const { getFinanceNumbers } = require('../../../../src/features/ai/tools/numbers/financeNumbers');
const { modeloSandbox } = require('../../_helpers/m9d025Fixtures');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); });
after(async () => { await F.sequelize.close(); });

test('adv_resposta_financeira_bate_com_read_model', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    await F.inadimplencia(tenantA, tx);
    const payload = await getFinanceNumbers({ ...F.ctxDe(tenantA), permissions: F.PERMISSOES.comFinanceiro }, tx);
    const sql = await F.inadimplenciaPorSql(tx);
    const modelo = modeloSandbox(['A inadimplência é de cerca de R$ 18 mil.', 'A inadimplência é de R$ {{num:inadimplencia_valor}} em {{num:inadimplencia_parcelas}} parcelas [1].']);
    const r = await numbers.produceNumericAnswer({ taskType: 'explicar_inadimplencia', numbersPayload: payload, model: modelo, sourceCount: 1 });
    assert.ok(!/18 mil/.test(r.text), 'o valor inventado pelo modelo não chega à pessoa');
    const centavos = [...r.text.matchAll(/R\$\s*([\d.]+,\d{2})/g)].map((m) => m[1].replace(/\./g, '').replace(',', ''));
    assert.deepEqual(centavos, [String(Math.round(Number(sql.total) * 100))], 'valor final igual ao read model, em centavos');
    assert.equal(r.text, `A inadimplência é de R$ ${numbers.formatPtBr(sql.total, 2)} em ${sql.n} parcelas [1].`);
    const g = validateGrounding({ answerText: r.text, taskType: 'explicar_inadimplencia', snapshotAt: payload[0].asOf, sources: [{ sourceType: 'READ_MODEL', sourceRef: 'finance.getWeeklyHealthReport', title: 'Saúde financeira', excerpt: null, values: payload.map((i) => numbers.formatItem(i)), retrievedAt: payload[0].asOf }] }, {});
    assert.equal(g.groundingStatus, 'GROUNDED');
  });
});
