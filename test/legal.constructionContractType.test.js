'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const projectsService = require('../src/features/construction/projects.service');
const AppError = require('../src/utils/AppError');

// M6-104 — tipo de contrato CONSTRUCTION (dependência cruzada Marco 5 <-> Marco 6): contrato
// de empreitada precisa existir no módulo Jurídico E se vincular a uma obra real em
// construction.projects via constructionProjectId.

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('CONSTRUCTION é um contractType válido em CONTRACT_TYPES', () => {
  assert.ok(contractsService.CONTRACT_TYPES.includes('CONSTRUCTION'));
});

test('contrato CONSTRUCTION sem constructionProjectId é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        contractsService.createContract(
          { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'CONSTRUCTION', totalValue: 250000 },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_CONTRACT_CONSTRUCTION_PROJECT_REQUIRED');
        return true;
      }
    );
  });
});

test('contrato CONSTRUCTION com constructionProjectId é criado e vinculado à obra', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await projectsService.createProject(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Obra Empreitada ${suffix}` },
      tenant.userId,
      transaction
    );

    const contract = await contractsService.createContract(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractType: 'CONSTRUCTION',
        totalValue: 250000,
        constructionProjectId: project.id,
      },
      tenant.userId,
      transaction
    );

    assert.equal(contract.contractType, 'CONSTRUCTION');
    assert.equal(contract.constructionProjectId, project.id);
    assert.equal(contract.status, 'DRAFT');
    assert.ok(contract.contractNumber.startsWith('OBR-'));
  });
});

test('outros tipos de contrato continuam não exigindo constructionProjectId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'SERVICE', totalValue: 5000 },
      tenant.userId,
      transaction
    );
    assert.equal(contract.constructionProjectId, null);
  });
});
