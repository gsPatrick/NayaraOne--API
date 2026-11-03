'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');

// GAP REAL CORRIGIDO (auditoria externa Abacus AI, 11/10/2026 — Marco 3, CRMX-003 "Imóvel
// único"): dois imóveis com a mesma matrícula física eram aceitos sem bloqueio.
after(async () => {
  await sequelize.close();
});

test('CRMX-003: dois imóveis com a mesma matrícula no mesmo grupo são bloqueados', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const registryNumber = `MAT-AUDIT-${uniqueSuffix()}`;
    await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel A',
        internalCode: `IC-A-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
        registryNumber,
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        propertiesService.createProperty(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            title: 'Imóvel B',
            internalCode: `IC-B-${uniqueSuffix()}`,
            propertyType: 'RESIDENTIAL',
            registryNumber,
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'PROPERTY_REGISTRY_NUMBER_DUPLICATE');
        return true;
      }
    );
  });
});

test('CRMX-003: matrículas diferentes ou nulas não conflitam', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const p1 = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel C',
        internalCode: `IC-C-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
        registryNumber: `MAT-${uniqueSuffix()}-1`,
      },
      tenant.userId,
      transaction
    );
    const p2 = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel D',
        internalCode: `IC-D-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
        registryNumber: `MAT-${uniqueSuffix()}-2`,
      },
      tenant.userId,
      transaction
    );
    const p3 = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel E (sem matrícula)',
        internalCode: `IC-E-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );
    const p4 = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel F (sem matrícula também)',
        internalCode: `IC-F-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );
    assert.ok(p1.id && p2.id && p3.id && p4.id);
  });
});

test('CRMX-003: update para uma matrícula já usada por OUTRO imóvel é bloqueado', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const registryNumber = `MAT-UPD-${uniqueSuffix()}`;
    await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel G',
        internalCode: `IC-G-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
        registryNumber,
      },
      tenant.userId,
      transaction
    );
    const propH = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel H',
        internalCode: `IC-H-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => propertiesService.updateProperty(propH.id, { registryNumber }, tenant.userId, transaction, tenant),
      (err) => {
        assert.equal(err.code, 'PROPERTY_REGISTRY_NUMBER_DUPLICATE');
        return true;
      }
    );
  });
});

test('CRMX-003: re-salvar a MESMA matrícula no MESMO imóvel (update idempotente) não bloqueia a si mesmo', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const registryNumber = `MAT-SELF-${uniqueSuffix()}`;
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'Imóvel I',
        internalCode: `IC-I-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
        registryNumber,
      },
      tenant.userId,
      transaction
    );

    const updated = await propertiesService.updateProperty(
      property.id,
      { registryNumber, title: 'Imóvel I (atualizado)' },
      tenant.userId,
      transaction,
      tenant
    );
    assert.equal(updated.registryNumber, registryNumber);
    assert.equal(updated.title, 'Imóvel I (atualizado)');
  });
});
