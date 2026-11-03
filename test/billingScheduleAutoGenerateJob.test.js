'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const rentAdjustmentService = require('../src/features/billing/rentAdjustment.service');
const { createMockIndexSourceAdapter } = require('../src/features/billing/adapters/IndexSourceAdapter');
const { BillingSchedule } = require('../src/models');
const {
  generateBillingSchedulesInTransaction,
} = require('../src/engines/jobs/billingScheduleAutoGenerateJob');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseContract(transaction, overrides = {}) {
  return contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 2000, ...overrides },
    tenant.userId,
    transaction
  );
}

async function activateContract(contract, transaction) {
  contract.status = 'ACTIVE';
  await contract.save({ transaction });
  return contract;
}

// Item "Billing mensal automático de locação" (auditoria externa Nayara, 11/10/2026): o
// backend de billing existia pronto, mas só era acionável manualmente — nenhuma automação
// mensal rodava sozinha. Este teste chama a mesma função que o job de produção usa, sem abrir
// transação própria (o helper aceita a transação de teste já aberta).
test('billing auto-generate: contrato LEASE ativo sem cobrança na competência recebe uma gerada automaticamente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction, { totalValue: 1800 });
    await activateContract(contract, transaction);

    const period = '2031-01';
    const result = await generateBillingSchedulesInTransaction(transaction, { period });

    assert.ok(result.generated >= 1, 'pelo menos este contrato deve ter gerado cobrança');

    const schedule = await BillingSchedule.findOne({ where: { contractId: contract.id, period }, transaction });
    assert.ok(schedule, 'cronograma de cobrança da competência foi criado');
    assert.equal(Number(schedule.totalAmount), 1800, 'valor do aluguel usado é o do contrato (sem reajuste aplicado ainda)');
  });
});

test('billing auto-generate: rodar duas vezes na MESMA competência não duplica (idempotente)', async () => {
  // Assertivas por CONTRATO específico, não pelos contadores globais do job — o tenant de
  // teste é compartilhado no banco de dev e pode ter outros contratos LEASE ACTIVE de rodadas
  // anteriores, então "generated"/"skipped" globais não são estáveis entre execuções.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction, { totalValue: 1500 });
    await activateContract(contract, transaction);

    const period = '2031-02';
    await generateBillingSchedulesInTransaction(transaction, { period });
    const afterFirst = await BillingSchedule.findOne({ where: { contractId: contract.id, period }, transaction });
    assert.ok(afterFirst, 'primeira rodada gerou a cobrança deste contrato');

    await generateBillingSchedulesInTransaction(transaction, { period });

    const schedules = await BillingSchedule.findAll({ where: { contractId: contract.id, period }, transaction });
    assert.equal(schedules.length, 1, 'nunca duplica a competência deste contrato');
  });
});

test('billing auto-generate: usa o valor do ÚLTIMO reajuste APLICADO em vez do valor original do contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction, { totalValue: 1000 });
    await activateContract(contract, transaction);

    const mockAdapter = createMockIndexSourceAdapter({ 'IPCA:2031-03': 10 }); // +10%
    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2031-03',
        indexCode: 'IPCA',
        oldRentAmount: 1000,
      },
      tenant.userId,
      transaction,
      mockAdapter
    );
    assert.equal(adjustment.status, 'APPLIED');
    assert.equal(Number(adjustment.newRentAmount), 1100);

    const billingPeriod = '2031-04';
    await generateBillingSchedulesInTransaction(transaction, { period: billingPeriod });

    const schedule = await BillingSchedule.findOne({ where: { contractId: contract.id, period: billingPeriod }, transaction });
    assert.ok(schedule);
    assert.equal(Number(schedule.totalAmount), 1100, 'aluguel cobrado já reflete o reajuste aplicado, não o valor original');
  });
});

test('billing auto-generate: contrato LEASE não-ativo (DRAFT) é ignorado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const draftContract = await createLeaseContract(transaction, { totalValue: 999 }); // permanece DRAFT, nunca ativado
    const activeContract = await createLeaseContract(transaction, { totalValue: 700 });
    await activateContract(activeContract, transaction);

    const period = '2031-07';
    await generateBillingSchedulesInTransaction(transaction, { period });

    const draftSchedule = await BillingSchedule.findOne({ where: { contractId: draftContract.id, period }, transaction });
    assert.equal(draftSchedule, null, 'contrato DRAFT nunca recebe cobrança automática');

    const activeSchedule = await BillingSchedule.findOne({ where: { contractId: activeContract.id, period }, transaction });
    assert.ok(activeSchedule, 'contrato ACTIVE recebe cobrança normalmente');
  });
});
