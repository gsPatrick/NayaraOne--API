'use strict';

// Marco 4 — Guia §11 "Comissão proporcional": rules.evaluate('REG-FIN-001', ctx, { finance: { receivedAmount }, contract }) (DEC-005: REG-FIN-001 é
// a comissão; REG-FIN-002 é o limite de aprovação do Guia §4). Guia §18 "Não usar float para dinheiro" / FIN-008: a comissão é base x percentual em
// decimal exato, arredondada UMA vez ao centavo pelo modo da versão da regra (DI-M4CC-1, padrão HALF_UP). Antes: Math.round(float), 50% de 0,29 dava
// 0,14 e 50% de 0,01 dava 0,01 (meio centavo ora para baixo, ora para cima).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, createTestResultCenter, uniqueSuffix } = require('./testHelpers');
const commissionsService = require('../src/modules/finance/application/services/commission.service');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const commission = require('../src/modules/finance/domain/commission');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

/** Referência independente: centavos x percentual em BigInt, arredondamento meio-para-cima ou meio-para-par. */
function expected(baseText, pctText, mode) {
  const [bi, bf = ''] = baseText.split('.');
  const baseCents = BigInt(bi) * 100n + BigInt((bf + '00').slice(0, 2));
  const [pi, pf = ''] = pctText.split('.');
  const pUnits = BigInt(pi + pf);
  const den = 100n * 10n ** BigInt(pf.length);
  const num = baseCents * pUnits;
  let q = num / den;
  const twice = (num % den) * 2n;
  if (twice > den || (twice === den && (mode === 'HALF_UP' || q % 2n === 1n))) q += 1n;
  return `${q / 100n}.${String(q % 100n).padStart(2, '0')}`;
}

test('M4-G§18.1 comissão em decimal exato: meio centavo sempre para o mesmo lado (HALF_UP), e HALF_EVEN quando a regra pede', () => {
  assert.equal(commission.computeCommissionTotal('0.29', 50), '0.15');
  assert.equal(commission.computeCommissionTotal('0.01', 50), '0.01');
  assert.equal(commission.computeCommissionTotal('0.35', 10), '0.04');
  assert.equal(commission.computeCommissionTotal('1.13', 50), '0.57');
  assert.equal(commission.computeCommissionTotal('0.29', 50, 'HALF_EVEN'), '0.14');
  assert.equal(commission.computeCommissionTotal('0.01', 50, 'HALF_EVEN'), '0.00');
  assert.equal(commission.computeCommissionTotal('0.35', 10, 'HALF_EVEN'), '0.04');
  assert.equal(commission.computeCommissionTotal('1.13', 50, 'HALF_EVEN'), '0.56');
  assert.equal(commission.computeCommissionTotal('99999999999.99', 33.333333), '33333333000.00');
  // 2.000 combinações pseudoaleatórias contra a referência em BigInt.
  let seed = 4111;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 2000; i += 1) {
    const base = (Math.floor(rnd() * 10000000) / 100).toFixed(2);
    const pct = String(Math.floor(rnd() * 10000) / 100 || 0.01);
    for (const mode of ['HALF_UP', 'HALF_EVEN']) assert.equal(commission.computeCommissionTotal(base, pct, mode), expected(base, pct, mode), `${base} x ${pct}% ${mode}`);
  }
});

test('M4-G§18.1 parcelas e ajuste em centavos inteiros: a soma das parcelas é o total, sem resíduo', () => {
  const plan = commission.planInstallments('100.00', 3, '2026-11-01T12:00:00Z');
  assert.deepEqual(plan.map((p) => p.amount), ['33.33', '33.33', '33.34']);
  const odd = commission.planInstallments('0.10', 3);
  assert.deepEqual(odd.map((p) => p.amount), ['0.03', '0.03', '0.04']);
  assert.equal(odd.reduce((a, p) => a + Math.round(Number(p.amount) * 100), 0), 10);
  const adj = commission.computeCancellationAdjustment([{ status: 'PAID', amount: '0.10' }, { status: 'PAID', amount: '0.20' }, { status: 'PENDING', amount: '0.40' }], '0.70');
  assert.deepEqual(adj, { paidAmountBefore: 0.3, totalAmountBefore: 0.7, adjustmentAmount: -0.4 });
  assert.equal(commission.amountsMatch('0.30', 0.1 + 0.2), true, '0,1 + 0,2 em float não quebra a comparação de centavos');
});

async function receivable(t, amount) {
  const rc = await createTestResultCenter(tenant, t);
  return financialEntriesService.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId: rc.id, description: `Fato gerador REG-FIN-001 ${uniqueSuffix()}` },
    tenant.userId,
    t
  );
}

test('M4-G§11 comissão usa a regra REG-FIN-001 do Motor de Regras (DEC-005), grava a versão e passa receivedAmount à avaliação', async () => {
  assert.equal(commission.RULE_CODE, 'REG-FIN-001');
  await withRollbackTenantTransaction(tenant, async (t) => {
    const published = await commissionsService.publishCommissionRuleVersion({ groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 50 } }, tenant.userId, t);
    assert.equal(published.ruleCode, 'REG-FIN-001');
    assert.equal(published.rounding, 'HALF_UP');
    const [[rule]] = await sequelize.query('SELECT r.code FROM core.rules r JOIN core.rule_versions v ON v.rule_id = r.id WHERE v.id = :id', { replacements: { id: published.id }, transaction: t });
    assert.equal(rule.code, 'REG-FIN-001');
    const source = await receivable(t, 0.29);
    const { commission: c } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'BROKER', idempotencyKey: `reg001-${uniqueSuffix()}` }, tenant.userId, t
    );
    assert.equal(String(c.totalAmount), '0.15', '50% de R$ 0,29 = 0,145 -> 0,15 (HALF_UP)');
    assert.equal(c.ruleVersionId, published.id);
    const [[log]] = await sequelize.query(
      "SELECT input_facts_json AS f FROM core.rule_evaluation_log WHERE rule_version_id = :id ORDER BY evaluated_at DESC LIMIT 1", { replacements: { id: published.id }, transaction: t }
    );
    assert.equal(log.f.context.finance.receivedAmount, '0.29', 'Guia §11: finance.receivedAmount vai para a avaliação');
    assert.ok('contract' in log.f.context, 'Guia §11: o contrato vai como fato');
    const active = await commissionsService.getActiveCommissionRule(tenant.groupId, tenant.companyId, t);
    assert.equal(active.ruleCode, 'REG-FIN-001');
    assert.equal(active.rounding, 'HALF_UP');
  });
});

test('M4-G§11 arredondamento é da versão da regra: HALF_EVEN publicado vale para a próxima comissão; modo inválido é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(
      commissionsService.publishCommissionRuleVersion({ groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 50 }, rounding: 'CEIL' }, tenant.userId, t),
      (e) => e.code === 'FINANCE_COMMISSION_RULE_VALIDATION'
    );
    const v = await commissionsService.publishCommissionRuleVersion({ groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 50 }, rounding: 'half_even' }, tenant.userId, t);
    assert.equal(v.rounding, 'HALF_EVEN');
    const a = await receivable(t, 0.29);
    const b = await receivable(t, 0.01);
    const mk = (src) => commissionsService.createCommission({ groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: src.id, component: 'BROKER', idempotencyKey: `reg001-${uniqueSuffix()}` }, tenant.userId, t);
    assert.equal(String((await mk(a)).commission.totalAmount), '0.14');
    assert.equal(String((await mk(b)).commission.totalAmount), '0.00');
    const versions = await commissionsService.listCommissionRuleVersions(tenant.groupId, tenant.companyId, t);
    assert.equal(versions[0].rounding, 'HALF_EVEN');
  });
});
