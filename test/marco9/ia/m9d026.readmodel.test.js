'use strict';

// M9-D026 — a resposta financeira bate, centavo a centavo, com a consulta SQL independente do mesmo período. Roda com
// nayara_runtime (RLS real), com rollback. O "modelo" é o provider sandbox roteirizado, que tenta inventar "18 mil".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter } = require('../../testHelpers');
const financialEntriesService = require('../../../src/features/finance/financialEntries.service');
const { startOfBusinessDay } = require('../../../src/utils/businessDate');
const numbers = require('../../../src/features/ai/orchestrator/numbers');
const { validateGrounding } = require('../../../src/features/ai/orchestrator/grounding');
const { getFinanceNumbers } = require('../../../src/features/ai/tools/numbers/financeNumbers');
const { sequelize, q, prepararTenants, carregarPessoas, ctxDe } = require('../../helpers/aiRuns');
const { modeloSandbox } = require('../_helpers/m9d025Fixtures');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const comFinanceiro = (ctx) => ({ ...ctx, permissions: ['ai:use', 'finance:read'] });
const VALORES = ['2633.21', '2633.21', '2633.21', '2633.21', '2633.21', '2633.21', '2633.24']; // 7 parcelas = 18.432,50

async function criarInadimplencia(tenant, tx) {
  const suffix = uniqueSuffix();
  const cc = await createTestCostCenter(tenant, tx);
  const rc = await createTestResultCenter(tenant, tx);
  const base = { groupId: tenant.groupId, companyId: tenant.companyId, costCenterId: cc.id, resultCenterId: rc.id };
  const vencido = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  for (const [i, valor] of VALORES.entries()) {
    await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: valor, dueAt: vencido, description: `M9-D026 parcela ${i} ${suffix}` }, tenant.userId, tx,
    );
  }
}

/** Consulta independente (SQL do teste, fora do código da NAY): a receber próprio vencido antes de hoje. */
async function inadimplenciaPorSql(tx) {
  const [row] = await q(
    `SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text AS total, COUNT(*)::int AS n FROM finance.financial_entries
      WHERE status = 'PENDING' AND nature = 'RECEIVABLE' AND is_third_party_funds IS NOT TRUE AND due_at < :hoje`,
    { hoje: startOfBusinessDay(new Date()) }, tx,
  );
  return row;
}

test('m9d026_finance_number_igual_read_model', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await criarInadimplencia(tenantA, tx);
    const ctx = comFinanceiro(ctxDe(tenantA));
    const payload = await getFinanceNumbers(ctx, tx);
    const sql = await inadimplenciaPorSql(tx);
    const porRef = Object.fromEntries(payload.map((i) => [i.ref, i]));
    // a tool devolve o valor do read model, com asOf e origem
    assert.equal(Number(porRef.inadimplencia_valor.value).toFixed(2), Number(sql.total).toFixed(2));
    assert.equal(Number(porRef.inadimplencia_parcelas.value), sql.n);
    assert.equal(porRef.inadimplencia_valor.source, 'finance.getWeeklyHealthReport');
    assert.ok(porRef.inadimplencia_valor.asOf);
    assert.ok(Number(sql.total) >= 18432.5 && sql.n >= 7);
    // o valor que a pessoa lê é o do SQL, formatado pelo servidor
    const texto = numbers.renderPlaceholders('Inadimplência: {{num:inadimplencia_valor}} em {{num:inadimplencia_parcelas}} parcelas.', payload);
    assert.equal(texto, `Inadimplência: R$ ${numbers.formatPtBr(sql.total, 2)} em ${sql.n} parcelas.`);
  });
});

test('adv_resposta_financeira_bate_com_read_model', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await criarInadimplencia(tenantA, tx);
    const ctx = comFinanceiro(ctxDe(tenantA));
    const payload = await getFinanceNumbers(ctx, tx);
    const sql = await inadimplenciaPorSql(tx);
    const modelo = modeloSandbox([
      'A inadimplência é de cerca de R$ 18 mil.',
      'A inadimplência é de R$ {{num:inadimplencia_valor}} em {{num:inadimplencia_parcelas}} parcelas [1].',
    ]);
    const r = await numbers.produceNumericAnswer({ taskType: 'explicar_inadimplencia', numbersPayload: payload, model: modelo, sourceCount: 1 });
    assert.equal(modelo.chamadas.length, 2);
    assert.ok(!/18 mil/.test(r.text), 'o "18 mil" inventado não chega à pessoa');
    assert.equal(r.text, `A inadimplência é de R$ ${numbers.formatPtBr(sql.total, 2)} em ${sql.n} parcelas [1].`);
    // todo número do texto final casa, em centavos, com o read model
    const valores = [...r.text.matchAll(/R\$\s*([\d.]+,\d{2})/g)].map((m) => m[1].replace(/\./g, '').replace(',', ''));
    assert.deepEqual(valores, [String(Math.round(Number(sql.total) * 100))]);
    // e o texto passa também pelo grounding do passo 11, com a fonte do read model e o carimbo da leitura
    const g = validateGrounding({
      answerText: r.text, taskType: 'explicar_inadimplencia', snapshotAt: payload[0].asOf,
      sources: [{ sourceType: 'READ_MODEL', sourceRef: 'finance.getWeeklyHealthReport', title: 'Saúde financeira', excerpt: null, values: payload.map((i) => numbers.formatItem(i)), retrievedAt: payload[0].asOf }],
    }, {});
    assert.equal(g.groundingStatus, 'GROUNDED');
    assert.equal(g.sources[0].type, 'READ_MODEL');
    assert.equal(g.answer, r.text);
  });
});

test('m9d026_leitura_financeira_exige_finance_read_e_respeita_rls', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await criarInadimplencia(tenantA, tx);
    await assert.rejects(getFinanceNumbers({ ...ctxDe(tenantA), permissions: ['ai:use'] }, tx), { code: 'PERMISSION_DENIED', statusCode: 403 });
  });
  // a empresa B não enxerga a inadimplência criada na A: o read model roda sob o RLS do ator
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const payload = await getFinanceNumbers(comFinanceiro(ctxDe(tenantB)), tx);
    const sql = await inadimplenciaPorSql(tx);
    const porRef = Object.fromEntries(payload.map((i) => [i.ref, i]));
    assert.equal(Number(porRef.inadimplencia_valor.value).toFixed(2), Number(sql.total).toFixed(2));
    assert.ok(Number(porRef.inadimplencia_valor.value) < 18432.5 || sql.n < 7);
  });
});
