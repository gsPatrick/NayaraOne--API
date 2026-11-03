'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const propertyDedupService = require('../src/features/properties/propertyDedup.service');

// PENDÊNCIA REAL FECHADA (Marco 3, CRMX-010 "Deduplicação antes de criar": "Pessoa/imóvel
// semelhante exige revisão"). Diferente de CRMX-003 (matrícula idêntica, bloqueia), este
// cenário é endereço MUITO parecido sem matrícula igual — deve abrir revisão (aviso), nunca
// bloquear sozinho.
after(async () => {
  await sequelize.close();
});

test('CRMX-010: imóvel com endereço (logradouro+número+cidade) igual a outro já cadastrado gera aviso de possível duplicata', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const addressPayload = {
      zipCode: '01310-100',
      street: 'Avenida Paulista',
      number: '1578',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    };

    const existing = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel original ${suffix}`,
        internalCode: `IC-ORIG-${suffix}`,
        propertyType: 'RESIDENTIAL',
        address: addressPayload,
      },
      tenant.userId,
      transaction
    );

    // Mesmo logradouro+número+cidade, grafia levemente diferente (acento/maiúscula/espaço) —
    // o normalizador deve considerar igual.
    const warnings = await propertyDedupService.findSimilarProperties(
      {
        groupId: tenant.groupId,
        street: 'avenida   paulista',
        number: '1578',
        city: 'Sao Paulo',
      },
      transaction
    );

    assert.equal(warnings.length, 1, 'deveria encontrar exatamente 1 candidato semelhante');
    assert.equal(warnings[0].propertyId, existing.id);
    assert.equal(warnings[0].reason, 'ENDERECO_SEMELHANTE');
  });
});

test('CRMX-010: endereços genuinamente diferentes não disparam aviso', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel X ${suffix}`,
        internalCode: `IC-X-${suffix}`,
        propertyType: 'RESIDENTIAL',
        address: {
          zipCode: '04538-132',
          street: 'Rua Funchal',
          number: '418',
          neighborhood: 'Vila Olímpia',
          city: 'São Paulo',
          state: 'SP',
        },
      },
      tenant.userId,
      transaction
    );

    const warnings = await propertyDedupService.findSimilarProperties(
      {
        groupId: tenant.groupId,
        street: 'Rua das Palmeiras',
        number: '99',
        city: 'Campinas',
      },
      transaction
    );

    assert.equal(warnings.length, 0);
  });
});

test('CRMX-010: criação via createProperty não bloqueia mesmo com endereço semelhante (só CRMX-003/matrícula bloqueia)', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const addressPayload = {
      zipCode: '20040-020',
      street: 'Avenida Rio Branco',
      number: '1',
      neighborhood: 'Centro',
      city: 'Rio de Janeiro',
      state: 'RJ',
    };

    await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel A ${suffix}`,
        internalCode: `IC-A-${suffix}`,
        propertyType: 'COMMERCIAL',
        address: addressPayload,
      },
      tenant.userId,
      transaction
    );

    // Mesmo endereço, matrícula ausente nos dois — createProperty não deve lançar erro (a
    // dedup por endereço é um aviso, não um bloqueio de banco/aplicação).
    const second = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel B ${suffix}`,
        internalCode: `IC-B-${suffix}`,
        propertyType: 'COMMERCIAL',
        address: addressPayload,
      },
      tenant.userId,
      transaction
    );

    assert.ok(second.id);
  });
});
