'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../src/features/correspondent/cases/simulations.service');
const eligibilityService = require('../src/features/correspondent/eligibility.service');
const { Person, Simulation, Property } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createCase(transaction, overrides = {}) {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Eligibility ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      providerCode: overrides.providerCode || 'sandbox',
      purpose: overrides.purpose || 'RESIDENCIAL',
      applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
      propertyId: overrides.propertyId || null,
    },
    tenant.userId,
    transaction
  );
}

async function createPropertyWithState(transaction, state) {
  const suffix = uniqueSuffix();
  return Property.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel Eligibility ${suffix}`,
      internalCode: `ELIG-${suffix}`,
      propertyType: 'HOUSE',
      state,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

test('CORRESPONDENT-ELIG-01: case elegível (sandbox, RESIDENCIAL, valor dentro do teto) passa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const result = await eligibilityService.assertEligible(financingCase, { amount: 500000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(result.eligible, true);
    assert.ok(result.ruleVersionId);
  });
});

test('CORRESPONDENT-ELIG-02: valor acima do teto do provider é bloqueado com motivo claro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await assert.rejects(
      () => eligibilityService.assertEligible(financingCase, { amount: 5000000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'COR_ELIGIBILITY_AMOUNT_EXCEEDS_LIMIT');
        assert.match(err.message, /acima do limite/);
        return true;
      }
    );
  });
});

test('CORRESPONDENT-ELIG-03: provider manual não tem teto de valor (null = sem limite)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, { providerCode: 'manual' });
    const result = await eligibilityService.assertEligible(financingCase, { amount: 50000000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(result.eligible, true);
  });
});

test('CORRESPONDENT-ELIG-04: createSimulation bloqueia ANTES de chamar o adapter quando o case é inelegível', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await assert.rejects(
      () => simulationsService.createSimulation(financingCase.id, { amount: 9999999, termMonths: 360 }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'COR_ELIGIBILITY_AMOUNT_EXCEEDS_LIMIT');
        return true;
      }
    );
    const count = await Simulation.count({ where: { financingCaseId: financingCase.id }, transaction });
    assert.equal(count, 0, 'nenhuma simulação deve ter sido persistida — o adapter nem deveria ter sido chamado');
  });
});

test('CORRESPONDENT-ELIG-05: createSimulation passa normalmente quando o case é elegível', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const simulation = await simulationsService.createSimulation(financingCase.id, { amount: 300000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.ok(simulation.id);
    assert.equal(Number(simulation.amount), 300000);
  });
});

test('CORRESPONDENT-ELIG-06: provider não habilitado na regra é bloqueado com motivo claro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Publica uma versão da regra sem "sandbox" entre os providers habilitados.
    await eligibilityService.publishProviderEligibilityVersion(
      tenant.groupId,
      tenant.companyId,
      { allowedProviders: ['manual'], allowedPurposes: ['RESIDENCIAL', 'COMERCIAL'], maxAmountByProvider: { manual: null } },
      tenant.userId,
      transaction
    );
    const financingCase = await createCase(transaction, { providerCode: 'sandbox' });
    await assert.rejects(
      () => eligibilityService.assertEligible(financingCase, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'COR_ELIGIBILITY_PROVIDER_NOT_ALLOWED');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-ELIG-07: finalidade não habilitada na regra é bloqueada com motivo claro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await eligibilityService.publishProviderEligibilityVersion(
      tenant.groupId,
      tenant.companyId,
      { allowedProviders: ['sandbox', 'manual'], allowedPurposes: ['COMERCIAL'], maxAmountByProvider: { sandbox: 2000000, manual: null } },
      tenant.userId,
      transaction
    );
    const financingCase = await createCase(transaction, { purpose: 'RESIDENCIAL' });
    await assert.rejects(
      () => eligibilityService.assertEligible(financingCase, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'COR_ELIGIBILITY_PURPOSE_NOT_ALLOWED');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-ELIG-08: resolveEligibilityConfig semeia o padrão automaticamente no primeiro uso', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { action, ruleVersionId } = await eligibilityService.resolveEligibilityConfig(tenant.groupId, tenant.companyId, transaction, tenant.userId);
    assert.ok(ruleVersionId);
    assert.deepEqual(action.allowedProviders.sort(), ['manual', 'sandbox']);
    assert.equal(action.maxAmountByProvider.sandbox, 2000000);
  });
});

test('CORRESPONDENT-ELIG-09: imóvel fora da UF habilitada para o provider é bloqueado com motivo claro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await eligibilityService.publishProviderEligibilityVersion(
      tenant.groupId,
      tenant.companyId,
      { ...eligibilityService.DEFAULT_ACTION, allowedStatesByProvider: { sandbox: ['SP', 'RJ'] } },
      tenant.userId,
      transaction
    );
    const property = await createPropertyWithState(transaction, 'MG');
    const financingCase = await createCase(transaction, { propertyId: property.id });
    await assert.rejects(
      () => eligibilityService.assertEligible(financingCase, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'COR_ELIGIBILITY_REGION_NOT_ALLOWED');
        assert.match(err.message, /MG/);
        return true;
      }
    );
  });
});

test('CORRESPONDENT-ELIG-10: imóvel dentro da UF habilitada passa normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await eligibilityService.publishProviderEligibilityVersion(
      tenant.groupId,
      tenant.companyId,
      { ...eligibilityService.DEFAULT_ACTION, allowedStatesByProvider: { sandbox: ['SP', 'RJ'] } },
      tenant.userId,
      transaction
    );
    const property = await createPropertyWithState(transaction, 'SP');
    const financingCase = await createCase(transaction, { propertyId: property.id });
    const result = await eligibilityService.assertEligible(financingCase, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(result.eligible, true);

  });
});

test('CORRESPONDENT-ELIG-11: case sem propertyId vinculado não é bloqueado por região por padrão (não há como verificar); o admin pode ligar o bloqueio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await eligibilityService.publishProviderEligibilityVersion(
      tenant.groupId,
      tenant.companyId,
      { ...eligibilityService.DEFAULT_ACTION, allowedStatesByProvider: { sandbox: ['SP', 'RJ'] } },
      tenant.userId,
      transaction
    );
    const financingCase = await createCase(transaction);
    const result = await eligibilityService.assertEligible(financingCase, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(result.eligible, true);
    await eligibilityService.publishProviderEligibilityVersion(
      tenant.groupId,
      tenant.companyId,
      { ...eligibilityService.DEFAULT_ACTION, allowedStatesByProvider: { sandbox: ['SP', 'RJ'] }, blockWhenPropertyRegionUnknown: true },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => eligibilityService.assertEligible(financingCase, { amount: 100000 }, tenant.groupId, tenant.companyId, tenant.userId, transaction),
      (err) => err.code === 'COR_ELIGIBILITY_REGION_UNKNOWN'
    );

  });
});
