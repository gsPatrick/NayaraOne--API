'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../src/features/correspondent/cases/simulations.service');
const { Person } = require('../src/models');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

async function createCase(transaction, providerCode) {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Sim ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, providerCode, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    transaction
  );
}

test('CORRESPONDENT-SIM-01: cria simulação via adapter sandbox (determinístico) e persiste parcela/taxa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const simulation = await simulationsService.createSimulation(
      financingCase.id,
      { amount: 200000, termMonths: 360 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(simulation.providerCode, 'sandbox');
    assert.equal(Number(simulation.amount), 200000);
    assert.equal(simulation.termMonths, 360);
    assert.ok(Number(simulation.monthlyPayment) > 0);
    assert.equal(Number(simulation.rate), 0.012);
    assert.equal(simulation.requestSnapshot.amount, 200000);
    assert.ok(simulation.responseSnapshot.externalId);
  });
});

test('CORRESPONDENT-SIM-02: o cálculo do sandbox é determinístico para os mesmos parâmetros', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const a = await simulationsService.createSimulation(financingCase.id, { amount: 150000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const b = await simulationsService.createSimulation(financingCase.id, { amount: 150000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(Number(a.monthlyPayment), Number(b.monthlyPayment));
    assert.notEqual(a.id, b.id, 'cada simulação é uma linha nova, nunca reaproveita/sobrescreve');
  });
});

test('CORRESPONDENT-SIM-03: múltiplas simulações do mesmo case ficam todas versionadas (nenhuma é sobrescrita)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 300000, termMonths: 360 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const list = await simulationsService.listSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(list.length, 2);
    assert.ok(Number(list[0].amount) !== Number(list[1].amount) || list[0].id !== list[1].id);
  });
});

test('CORRESPONDENT-SIM-04: listSimulations retorna mais recente primeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const first = await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 60 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const second = await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const list = await simulationsService.listSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(list[0].id, second.id);
    assert.equal(list[1].id, first.id);
  });
});

test('CORRESPONDENT-SIM-05: rejeita amount <= 0', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    await assert.rejects(
      () => simulationsService.createSimulation(financingCase.id, { amount: 0, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => err.code === 'SIMULATION_VALIDATION'
    );
  });
});

test('CORRESPONDENT-SIM-06: rejeita termMonths ausente/inválido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    await assert.rejects(
      () => simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 0 }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => err.code === 'SIMULATION_VALIDATION'
    );
  });
});

test('CORRESPONDENT-SIM-07: provider manual não simula sozinho — sem a parcela que o banco simulou, erro claro, nunca 500 cru', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'manual');
    await assert.rejects(
      () => simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => err.code === 'SIMULATION_VALIDATION' && err.statusCode === 400 && /parcela que o banco simulou/.test(err.message)
    );
  });
});

test('CORRESPONDENT-SIM-08: financing_case inexistente/de outra empresa — NOT_FOUND', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        simulationsService.createSimulation(
          '00000000-0000-0000-0000-000000000000',
          { amount: 100000, termMonths: 120 },
          tenant.userId,
          tenant.groupId,
          tenant.companyId,
          transaction
        ),
      (err) => err.code === 'FINANCING_CASE_NOT_FOUND'
    );
  });
});

// RLS cross-company — mesmo padrão adversarial já usado em correspondent.financingCases.test.js.
test('CORRESPONDENT-SIM-09: outra empresa não enxerga simulação via SELECT direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const simulation = await simulationsService.createSimulation(
      financingCase.id,
      { amount: 100000, termMonths: 120 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [rows] = await sequelize.query('SELECT id FROM "correspondent"."simulations" WHERE id = :id', {
      replacements: { id: simulation.id },
      transaction,
    });
    assert.equal(rows.length, 0, 'empresa diferente não deve conseguir SELECT na simulação da empresa original');
  });
});
