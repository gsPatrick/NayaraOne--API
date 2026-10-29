'use strict';

// M9-D619 — os serviços do Jurídico publicam os eventos que o BI consome (processo atualizado, exigência atualizada), na mesma transação, e o valor
// confirmado do processo é validado e gravado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const { OutboxEvent } = require('../../../src/models');
const casesService = require('../../../src/features/legal/legalCases.service');
const contractsService = require('../../../src/features/legal/contracts.service');
const requirementsService = require('../../../src/features/legal/requirements.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(() => sequelize.close());

const eventsOf = (transaction, type, aggregateId) => OutboxEvent.findAll({ where: { eventType: type, aggregateId }, transaction });

test('m9d619 atualizar o processo publica legal.case.updated e grava o valor confirmado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await casesService.createLegalCase({ groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', estimatedAmount: 1000 }, tenant.userId, transaction);
    assert.equal((await eventsOf(transaction, 'legal.case.updated', legalCase.id)).length, 0, 'criar publica só legal.case.created');
    const updated = await casesService.updateLegalCase(legalCase.id, { riskLevel: 'high', confirmedAmount: '250.5' }, tenant.userId, transaction);
    assert.equal(updated.confirmedAmount, '250.50');
    const [event] = await eventsOf(transaction, 'legal.case.updated', legalCase.id);
    assert.deepEqual([event.payloadJson.riskLevel, event.payloadJson.status, event.companyId], ['HIGH', 'OPEN', tenant.companyId]);
    await assert.rejects(casesService.updateLegalCase(legalCase.id, { confirmedAmount: -1 }, tenant.userId, transaction), (e) => e.code === 'LEGAL_CASE_VALIDATION');
    await casesService.updateLegalCase(legalCase.id, { confirmedAmount: null }, tenant.userId, transaction);
    assert.equal((await casesService.getLegalCase(legalCase.id, transaction)).confirmedAmount, null);
    assert.equal((await eventsOf(transaction, 'legal.case.updated', legalCase.id)).length, 2, 'uma ocorrência por atualização, sem colidir na chave de idempotência');
  });
});

test('m9d619 gerar e atender exigências publica legal.contract_requirement.updated', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 }, tenant.userId, transaction);
    const created = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
    assert.ok(created.length > 0);
    for (const r of created) assert.equal((await eventsOf(transaction, 'legal.contract_requirement.updated', r.id)).length, 1, 'um evento por exigência gerada');
    const satisfied = await requirementsService.satisfyRequirement(created[0].id, { waivedReason: 'Dispensado no teste da M9-D619' }, tenant.userId, transaction);
    assert.equal(satisfied.status, 'WAIVED');
    const events = await eventsOf(transaction, 'legal.contract_requirement.updated', created[0].id);
    assert.deepEqual(events.map((e) => e.payloadJson.status).sort(), ['PENDING', 'WAIVED']);
  });
});
