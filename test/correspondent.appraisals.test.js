'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const appraisalsService = require('../src/features/correspondent/cases/appraisals.service');
const { Person, Property, PropertyOffer } = require('../src/models');

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

async function createProperty(transaction) {
  const suffix = uniqueSuffix();
  return Property.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel de teste avaliação ${suffix}`,
      internalCode: `APR-${suffix}`,
      propertyType: 'HOUSE',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function createOffer(transaction, propertyId, askingPrice) {
  return PropertyOffer.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      propertyId,
      offerType: 'SALE',
      askingPrice,
      status: 'ACTIVE',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function createCase(transaction, providerCode, propertyId) {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Apr ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      providerCode,
      propertyId: propertyId || null,
      applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
    },
    tenant.userId,
    transaction
  );
}

test('CORRESPONDENT-APR-01: solicita avaliação via adapter sandbox e persiste valor informativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const appraisal = await appraisalsService.createAppraisal(
      financingCase.id,
      { referenceValue: 300000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(appraisal.providerCode, 'sandbox');
    assert.equal(appraisal.status, 'COMPLETED');
    assert.ok(appraisal.requestedValue !== null);
    assert.ok(Number(appraisal.requestedValue) > 0);
    assert.ok(appraisal.externalId.startsWith('sandbox-appraisal-'));
  });
});

test('CORRESPONDENT-APR-02: provider "manual" não suporta avaliação — bloqueia com erro de negócio claro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'manual');
    await assert.rejects(
      () =>
        appraisalsService.createAppraisal(
          financingCase.id,
          { referenceValue: 300000 },
          tenant.userId,
          tenant.groupId,
          tenant.companyId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'APPRAISAL_NOT_SUPPORTED');
        assert.ok(!/sandbox|adapter|undefined/i.test(err.message));
        return true;
      }
    );
  });
});

test('CORRESPONDENT-APR-03: invariante crítico — avaliação NUNCA altera o preço do imóvel/oferta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createProperty(transaction);
    const offer = await createOffer(transaction, property.id, 500000);
    const financingCase = await createCase(transaction, 'sandbox', property.id);

    const appraisal = await appraisalsService.createAppraisal(
      financingCase.id,
      { referenceValue: 500000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );

    // O adapter sandbox varia o valor em até ±3% — garante que o valor avaliado É DIFERENTE do
    // preço da oferta, pra o teste ser uma prova real (não passaria por coincidência se os
    // valores fossem iguais).
    assert.notEqual(Number(appraisal.requestedValue), 500000);

    const offerAfter = await PropertyOffer.findByPk(offer.id, { transaction });
    assert.equal(Number(offerAfter.askingPrice), 500000, 'o preço da oferta não pode ter mudado');
    assert.equal(offerAfter.lockVersion, offer.lockVersion, 'a oferta não pode ter sido salva/tocada de nenhuma forma');
  });
});

test('CORRESPONDENT-APR-04: RLS — case de outra empresa não é encontrado (cross-company bloqueado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    await assert.rejects(
      () => appraisalsService.createAppraisal(financingCase.id, {}, tenant.userId, tenant.groupId, otherCompanyId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCING_CASE_NOT_FOUND');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-APR-05: evento appraisal.requested (e appraisal.completed) emitido no outbox', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const appraisal = await appraisalsService.createAppraisal(
      financingCase.id,
      { referenceValue: 100000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const [rows] = await sequelize.query(
      `SELECT event_type FROM integration.outbox_events WHERE aggregate_id = :id ORDER BY event_type`,
      { replacements: { id: appraisal.id }, transaction }
    );
    const types = rows.map((r) => r.event_type);
    assert.ok(types.includes('appraisal.requested'));
    assert.ok(types.includes('appraisal.completed'));
  });
});

test('CORRESPONDENT-APR-06: lista avaliações do case, mais recente primeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const first = await appraisalsService.createAppraisal(financingCase.id, { referenceValue: 100000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const second = await appraisalsService.createAppraisal(financingCase.id, { referenceValue: 200000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const list = await appraisalsService.listAppraisals(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, second.id);
    assert.equal(list[1].id, first.id);
  });
});
