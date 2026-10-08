'use strict';

// Auditoria rodada 3 (2026-10-08) — DoD Procurement "PO duplicado": a guarda contra adjudicar
// duas ofertas da MESMA Quotation já existia em awardSupplierOffer (procurement.service.js),
// mas sem teste automatizado cobrindo o cenário. Este arquivo acrescenta essa cobertura.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const procurementService = require('../src/features/procurement/procurement.service');
const { User } = require('../src/models');

let tenant;

async function createSecondUser(transaction, label) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return User.create(
    { name: `QA AUDITORIA R3 ${label} ${suffix}`, email: `qa-auditoria-r3-${label.toLowerCase()}-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
}

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

test('procurement: awardSupplierOffer bloqueia adjudicar uma SEGUNDA oferta da MESMA Quotation já adjudicada (QUOTATION_ALREADY_AWARDED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ description: `QA AUDITORIA R3 item ${suffix}`, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    const approver = await createSecondUser(transaction, 'approver');
    await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', approver.id, transaction);

    const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);

    // Duas ofertas RECEIVED diferentes para a MESMA cotação — valor baixo, abaixo do limiar de
    // segunda aprovação (REG-COM-001), pra não precisar de um segundo aprovador aqui.
    const offerA = await procurementService.submitSupplierOffer(
      quotation.id, tenant.groupId, tenant.companyId,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 5 }] },
      transaction
    );
    const offerB = await procurementService.submitSupplierOffer(
      quotation.id, tenant.groupId, tenant.companyId,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 4 }] },
      transaction
    );

    const order = await procurementService.awardSupplierOffer(offerA.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(order.status, 'OPEN');

    await assert.rejects(
      () => procurementService.awardSupplierOffer(offerB.id, tenant.groupId, tenant.companyId, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'QUOTATION_ALREADY_AWARDED');
        return true;
      }
    );
  });
});
