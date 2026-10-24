'use strict';

// Marco 8 — comissão com provider/fato gerador/split corretor-gerente e produto na elegibilidade,
// ambos vindos do Motor de Regras ("Split corretor/gerente vem do Motor de Regras",
// "Comissão guarda fato gerador, provider, base e rule_version_id").

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const commissions = require('../../src/features/correspondent/cases/commissionEntitlements.service');
const parameters = require('../../src/features/correspondent/parameters.service');
const { assertEligible } = require('../../src/features/correspondent/eligibility.service');
const { Person } = require('../../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const codigo = (c) => (err) => { assert.equal(err.code, c, `esperava ${c}, veio ${err.code}: ${err.message}`); return true; };

async function novoCaso(t, extra = {}) {
  const principal = await Person.create(
    { ...ctx(), personType: 'PF', legalName: `Proponente comissão ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  return financingCasesService.createFinancingCase(
    { ...ctx(), providerCode: 'manual', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }], ...extra },
    tenant.userId,
    t
  );
}

async function configurarComissao(t, patch) {
  const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
  return parameters.updateCommission({ ...atual.commission.action, ...patch }, 'Teste de split', tenant.userId, tenant.groupId, tenant.companyId, t);
}

test('M8-COM-01: comissão guarda provider, fato gerador, split e valores somando o total', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurarComissao(t, { percentageByProvider: { sandbox: 1.5, manual: 2 }, brokerSharePctByProvider: { sandbox: 100, manual: 60 } });
    const caso = await novoCaso(t);
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 100000, triggerEvent: 'CONTRATO_ASSINADO' }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(e.providerCode, 'manual');
    assert.equal(e.triggerEvent, 'CONTRATO_ASSINADO');
    assert.equal(Number(e.amount), 2000);
    assert.equal(Number(e.brokerSharePct), 60);
    assert.equal(Number(e.managerSharePct), 40);
    assert.equal(Number(e.brokerAmount), 1200);
    assert.equal(Number(e.managerAmount), 800);
    assert.equal(Number(e.brokerAmount) + Number(e.managerAmount), Number(e.amount));
    assert.ok(e.ruleVersionId);
  });
});

test('M8-COM-02: fato gerador fora da lista da regra é recusado e o padrão vale quando não informado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await novoCaso(t);
    await assert.rejects(
      commissions.createCommissionEntitlement(caso.id, { baseAmount: 1000, triggerEvent: 'QUALQUER_COISA' }, tenant.userId, tenant.groupId, tenant.companyId, t),
      codigo('COMMISSION_ENTITLEMENT_VALIDATION')
    );
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 1000 }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.ok(e.triggerEvent);
  });
});

test('M8-COM-03: centavos do split sempre fecham no total (33,33% corretor)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurarComissao(t, { brokerSharePctByProvider: { sandbox: 33.33, manual: 33.33 } });
    const caso = await novoCaso(t);
    const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: 12345.67 }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(Math.round((Number(e.brokerAmount) + Number(e.managerAmount)) * 100), Math.round(Number(e.amount) * 100));
  });
});

test('M8-PAR-01: parâmetros inválidos são recusados e a alteração gera versão nova e histórico', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const antes = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    await assert.rejects(parameters.updateCommission({ ...antes.commission.action, defaultBrokerSharePct: 120 }, 'x erro', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
    await assert.rejects(parameters.updateCommission(antes.commission.action, '', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
    await assert.rejects(parameters.updateEligibility({ ...antes.eligibility.action, allowedProducts: [] }, 'sem produto', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('CORRESPONDENT_PARAMETERS_VALIDATION'));
    const r = await parameters.updateEligibility({ ...antes.eligibility.action, maxAmountByProvider: { sandbox: 1500000, manual: null } }, 'Novo teto do sandbox', tenant.userId, tenant.groupId, tenant.companyId, t);
    const depois = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    assert.equal(depois.eligibility.history[0].versionNumber, r.versionNumber);
    assert.equal(depois.eligibility.history[0].effectiveUntil, null);
    assert.ok(depois.eligibility.history[1].effectiveUntil, 'versão anterior encerrada');
    assert.equal(depois.eligibility.action.maxAmountByProvider.sandbox, 1500000);
  });
});

test('M8-ELEG-PROD-01: produto desabilitado bloqueia o caso e produto inválido não cria o caso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const antes = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    await assert.rejects(novoCaso(t, { product: 'POUPANCA' }), codigo('FINANCING_CASE_VALIDATION'));
    const caso = await novoCaso(t, { product: 'CONSTRUCAO' });
    assert.equal(caso.product, 'CONSTRUCAO');
    await assertEligible(caso, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, t);
    await parameters.updateEligibility({ ...antes.eligibility.action, allowedProducts: ['FINANCIAMENTO_IMOBILIARIO'] }, 'Só financiamento', tenant.userId, tenant.groupId, tenant.companyId, t);
    await assert.rejects(assertEligible(caso, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, t), codigo('COR_ELIGIBILITY_PRODUCT_NOT_ALLOWED'));
  });
});
