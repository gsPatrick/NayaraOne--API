'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const contractAmendmentsService = require('../src/features/legal/contractAmendments.service');
const noticesService = require('../src/features/legal/notices.service');
const contractTimelineService = require('../src/features/legal/contractTimeline.service');
const { CollectionCase, BillingSchedule } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// AUD-015 (JUR-003, "Tipos de contrato"): o Caderno define 12 códigos específicos, só 4
// genéricos existiam. Confirma os 3 subtipos de locação mais usados no dia a dia.
test('AUD-015: subtipos de locação (LEASE_RESIDENTIAL/LEASE_COMMERCIAL/LEASE_SEASONAL/PROPERTY_ADMIN) são aceitos e numerados como locação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const subtype of ['LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL']) {
      const contract = await contractsService.createContract(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractType: subtype, totalValue: 1200 },
        tenant.userId,
        transaction
      );
      assert.equal(contract.contractType, subtype);
      assert.ok(contract.contractNumber.startsWith('LOC-'), `${subtype} usa o mesmo prefixo de numeração de locação`);
    }

    const admin = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'PROPERTY_ADMIN', totalValue: 500 },
      tenant.userId,
      transaction
    );
    assert.ok(admin.contractNumber.startsWith('ADM-'));
  });
});

test('AUD-015: subtipos de venda (SALE_CASH/SALE_FINANCED/SALE_TRADE/SALE_INSTALLMENTS) são aceitos', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const subtype of ['SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS']) {
      const contract = await contractsService.createContract(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractType: subtype, totalValue: 300000 },
        tenant.userId,
        transaction
      );
      assert.equal(contract.contractType, subtype);
      assert.ok(contract.contractNumber.startsWith('VEN-'));
    }
  });
});

test('AUD-015: contratos LEASE/SALE genéricos (dados já existentes) continuam funcionando sem quebra', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const lease = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    assert.equal(lease.contractType, 'LEASE');
    const sale = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'SALE', totalValue: 100000 },
      tenant.userId,
      transaction
    );
    assert.equal(sale.contractType, 'SALE');
  });
});

// AUD-017 (JUR-012, "timeline consolidada"): aditivo + notificação + inadimplência + reparo,
// tudo reunido numa única chamada, ordenado por data.
test('AUD-017: getContractTimeline reúne aditivo, notificação e inadimplência em ordem cronológica', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE_RESIDENTIAL', totalValue: 1500 },
      tenant.userId,
      transaction
    );

    const amendment = await contractAmendmentsService.createAmendment(
      contract.id,
      { reason: `Reajuste combinado ${uniqueSuffix()}`, changes: [{ field: 'totalValue', oldValue: 1500, newValue: 1600 }] },
      tenant.userId,
      transaction
    );

    const notice = await noticesService.createNotice(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, channel: 'EMAIL', content: 'Aviso de vencimento próximo' },
      tenant.userId,
      transaction
    );

    const billingSchedule = await BillingSchedule.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2031-09',
        dueDate: new Date('2031-09-10'),
        totalAmount: 1600,
        paidAmount: 0,
        balance: 1600,
        status: 'OPEN',
        generatedAt: new Date(),
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
    const collectionCase = await CollectionCase.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        billingScheduleId: billingSchedule.id,
        contractId: contract.id,
        status: 'OPEN',
        overdueSince: '2031-09-15',
        originalDebtAmount: 1600,
        currentBalance: 1600,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    const timeline = await contractTimelineService.getContractTimeline(contract.id, transaction);

    const types = timeline.items.map((i) => i.type);
    assert.ok(types.includes('AMENDMENT'), 'aditivo aparece na timeline');
    assert.ok(types.includes('NOTICE'), 'notificação aparece na timeline');
    assert.ok(types.includes('DELINQUENCY'), 'inadimplência aparece na timeline');
    assert.ok(types.includes('STATUS_CHANGE') || types.length >= 3, 'timeline consolidada tem múltiplas fontes');

    // Ordem cronológica: cada item não pode vir antes do anterior.
    for (let i = 1; i < timeline.items.length; i += 1) {
      const prev = new Date(timeline.items[i - 1].occurredAt || 0).getTime();
      const curr = new Date(timeline.items[i].occurredAt || 0).getTime();
      assert.ok(curr >= prev, 'timeline vem ordenada cronologicamente');
    }

    const amendmentItem = timeline.items.find((i) => i.referenceId === amendment.id);
    assert.ok(amendmentItem.summary.includes('Reajuste combinado'));
    const noticeItem = timeline.items.find((i) => i.referenceId === notice.id);
    assert.ok(noticeItem.summary.includes('EMAIL'));
    const delinquencyItem = timeline.items.find((i) => i.referenceId === collectionCase.id);
    assert.ok(delinquencyItem.summary.includes('1600'));
  });
});

test('AUD-017: timeline de contrato sem nenhum evento retorna lista vazia, sem erro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'SALE', totalValue: 50000 },
      tenant.userId,
      transaction
    );
    const timeline = await contractTimelineService.getContractTimeline(contract.id, transaction);
    assert.deepEqual(timeline.items, []);
  });
});
