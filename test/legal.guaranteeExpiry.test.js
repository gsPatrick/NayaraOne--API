'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const { processGuaranteesInTransaction, DEFAULT_ALERT_DAYS } = require('../src/engines/jobs/legalGuaranteeExpiryAlertJob');
const { OutboxEvent } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseContract(transaction) {
  return contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1500 },
    tenant.userId,
    transaction
  );
}

// JUR-TS-005 (Caderno, Anexo I "20. Testes adversariais"): "Garantia vencida → bloqueio/alerta
// conforme regra."
test('JUR-TS-005: garantia dentro da janela de antecedência dispara lease.guarantee.expiring', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const soon = new Date();
    soon.setDate(soon.getDate() + 5); // dentro do default de 30 dias de antecedência.
    const guarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 1000, status: 'ACTIVE', endsAt: soon.toISOString().slice(0, 10) },
      tenant.userId,
      transaction
    );

    const result = await processGuaranteesInTransaction(transaction);
    assert.ok(result.alerted >= 1);

    const event = await OutboxEvent.findOne({
      where: { aggregateType: 'Guarantee', aggregateId: guarantee.id, eventType: 'lease.guarantee.expiring' },
      transaction,
    });
    assert.ok(event, 'evento lease.guarantee.expiring deveria ter sido publicado');
  });
});

test('JUR-TS-005: garantia já vencida também é alertada (não só "prestes a vencer")', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const past = new Date();
    past.setDate(past.getDate() - 2);
    const guarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'INSURANCE', value: 1000, status: 'ACTIVE', endsAt: past.toISOString().slice(0, 10) },
      tenant.userId,
      transaction
    );

    await processGuaranteesInTransaction(transaction);
    const event = await OutboxEvent.findOne({
      where: { aggregateType: 'Guarantee', aggregateId: guarantee.id, eventType: 'lease.guarantee.expiring' },
      transaction,
    });
    assert.ok(event);
    assert.ok(event.payloadJson.daysUntilExpiry < 0);
  });
});

test('garantia com vencimento distante (fora da janela) não gera alerta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const far = new Date();
    far.setDate(far.getDate() + DEFAULT_ALERT_DAYS + 90);
    const guarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'CAPITALIZATION_TITLE', value: 1000, status: 'ACTIVE', endsAt: far.toISOString().slice(0, 10) },
      tenant.userId,
      transaction
    );

    await processGuaranteesInTransaction(transaction);
    const event = await OutboxEvent.findOne({
      where: { aggregateType: 'Guarantee', aggregateId: guarantee.id, eventType: 'lease.guarantee.expiring' },
      transaction,
    });
    assert.equal(event, null);
  });
});

// Caderno, Anexo I "9. Garantias locatícias": "contrato não perde histórico quando a garantia
// é substituída."
test('replaceGuarantee: garantia antiga vira registro histórico (nunca apagada) ligada à nova', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const oldGuarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 1000, status: 'ACTIVE' },
      tenant.userId,
      transaction
    );

    const { oldGuarantee: updatedOld, newGuarantee } = await guaranteesService.replaceGuarantee(
      oldGuarantee.id,
      { guaranteeType: 'INSURANCE', value: 1200, status: 'ACTIVE' },
      tenant.userId,
      transaction
    );

    assert.equal(updatedOld.status, 'RELEASED');
    assert.equal(updatedOld.replacedByGuaranteeId, newGuarantee.id);
    assert.equal(newGuarantee.status, 'ACTIVE');
    assert.equal(newGuarantee.contractId, contract.id);

    // Nunca apagada: ainda existe e é lida normalmente.
    const stillThere = await guaranteesService.getGuarantee(oldGuarantee.id, transaction);
    assert.equal(stillThere.id, oldGuarantee.id);
    assert.equal(stillThere.guaranteeType, 'DEPOSIT'); // tipo/valor originais preservados.
  });
});
