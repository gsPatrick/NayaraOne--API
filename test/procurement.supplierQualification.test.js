'use strict';

// "Fornecedores: documentos/vigência; due diligence para alto risco" (Caderno COMPRAS).
// BUG REAL CORRIGIDO (auditoria contratual Marco 7, 2026-10-07): awardSupplierOffer comparava
// `new Date(validUntil) < new Date()` — validUntil é DATEONLY, então "válido até hoje" virava
// meia-noite UTC de hoje e o fornecedor já contava como VENCIDO no próprio último dia de
// vigência (desde 21h do dia anterior, em São Paulo). A vigência inclui o último dia.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const procurementService = require('../src/features/procurement/procurement.service');
const { Person } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

function saoPauloDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

async function offerFromApprovedHighRiskSupplier(transaction, validUntil) {
  const supplier = await Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `QA Vigência ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  const qualification = await procurementService.upsertSupplierQualification(
    withTenant({ supplierPersonId: supplier.id, highRisk: true, validUntil }),
    tenant.userId,
    transaction
  );
  await procurementService.decideSupplierDueDiligence(qualification.id, { decision: 'APPROVED' }, { userId: tenant.userId }, transaction);

  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ description: `QA vigência item ${uniqueSuffix()}`, quantity: 2 }] }),
    tenant.userId,
    transaction
  );
  await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
  return procurementService.submitSupplierOffer(
    quotation.id,
    { supplierPersonId: supplier.id, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 10 }] },
    transaction
  );
}

test('Due diligence: vigência que termina HOJE ainda permite adjudicar (último dia incluso)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const offer = await offerFromApprovedHighRiskSupplier(transaction, saoPauloDate(0));
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    assert.equal(order.status, 'OPEN');
  });
});

test('Due diligence: vigência que terminou ONTEM bloqueia a adjudicação mesmo com due diligence APPROVED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const offer = await offerFromApprovedHighRiskSupplier(transaction, saoPauloDate(-1));
    await assert.rejects(
      () => procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'SUPPLIER_DUE_DILIGENCE_REQUIRED'); return true; }
    );
  });
});
