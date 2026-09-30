'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const materialRequestsService = require('../src/features/construction/materialRequests.service');
const AppError = require('../src/utils/AppError');
const { OutboxEvent } = require('../src/models');

// M6-28 — requisição de material mínima do Marco 6 (integração completa com Estoque é do
// Marco 7, ver src/features/construction/README.md).

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTestProject(transaction) {
  const suffix = uniqueSuffix();
  return projectsService.createProject(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      name: `Obra Material ${suffix}`,
    },
    tenant.userId,
    transaction
  );
}

test('material-request: criar requisição publica evento material.requested', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);

    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Cimento CP-II', quantity: 50, unit: 'saco' },
      tenant.userId,
      transaction
    );

    assert.equal(request.status, 'REQUESTED');
    assert.equal(request.projectId, project.id);

    const events = await OutboxEvent.findAll({
      where: { aggregateType: 'MaterialRequest', aggregateId: request.id, eventType: 'material.requested' },
      transaction,
    });
    assert.equal(events.length, 1);
  });
});

test('material-request: validação exige description/quantity/unit', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);

    await assert.rejects(
      () =>
        materialRequestsService.createMaterialRequest(
          project.id,
          { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Areia' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MATERIAL_REQUEST_VALIDATION');
        return true;
      }
    );
  });
});

test('material-request: quantity precisa ser maior que zero', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);

    await assert.rejects(
      () =>
        materialRequestsService.createMaterialRequest(
          project.id,
          { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Areia', quantity: 0, unit: 'm3' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_VALIDATION');
        return true;
      }
    );
  });
});

test('material-request: vínculo com stageId de outra obra é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const otherProject = await createTestProject(transaction);
    const stageOfOtherProject = await projectStagesService.createProjectStage(
      otherProject.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, name: 'Fundação' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        materialRequestsService.createMaterialRequest(
          project.id,
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            description: 'Vergalhão',
            quantity: 100,
            unit: 'kg',
            stageId: stageOfOtherProject.id,
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_STAGE_INVALID');
        return true;
      }
    );
  });
});

test('material-request: receber marca RECEIVED e publica material.received (idempotente contra dupla confirmação)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Tijolo', quantity: 1000, unit: 'unidade' },
      tenant.userId,
      transaction
    );

    const received = await materialRequestsService.receiveMaterialRequest(request.id, tenant.userId, transaction);
    assert.equal(received.status, 'RECEIVED');
    assert.ok(received.receivedAt);

    const events = await OutboxEvent.findAll({
      where: { aggregateType: 'MaterialRequest', aggregateId: request.id, eventType: 'material.received' },
      transaction,
    });
    assert.equal(events.length, 1);

    // Confirmar recebimento uma segunda vez tem que bloquear — não pode disparar o evento de
    // novo nem voltar silenciosamente sem erro (mesmo padrão de "não duplicar" do módulo).
    await assert.rejects(
      () => materialRequestsService.receiveMaterialRequest(request.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_ALREADY_RECEIVED');
        return true;
      }
    );
  });
});

test('material-request: listMaterialRequests filtra por status', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const requestA = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Prego', quantity: 5, unit: 'kg' },
      tenant.userId,
      transaction
    );
    await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Massa corrida', quantity: 10, unit: 'lata' },
      tenant.userId,
      transaction
    );
    await materialRequestsService.receiveMaterialRequest(requestA.id, tenant.userId, transaction);

    const received = await materialRequestsService.listMaterialRequests(project.id, transaction, { status: 'RECEIVED' });
    assert.equal(received.length, 1);
    assert.equal(received[0].id, requestA.id);

    const requested = await materialRequestsService.listMaterialRequests(project.id, transaction, { status: 'REQUESTED' });
    assert.equal(requested.length, 1);
  });
});
