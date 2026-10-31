'use strict';

/**
 * Auditoria da cliente, Marco 6 (achado 4): depois de FECHADO, Editar permitia retirar a causa
 * raiz (ou as evidencias) e conservar o status Fechado. Os requisitos de fechamento valem em
 * qualquer atualizacao de um chamado fechado.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Property, MaintenanceCase } = require('../src/models');
const service = require('../src/features/construction/maintenanceCases.service');
const AppError = require('../src/utils/AppError');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const BEFORE = ['11111111-1111-1111-1111-111111111111'];
const AFTER = ['22222222-2222-2222-2222-222222222222'];

const rejectsWith = (code, status) => (err) => {
  assert.ok(err instanceof AppError);
  assert.equal(err.code, code);
  if (status) assert.equal(err.statusCode, status);
  return true;
};

async function closedCase(transaction) {
  const suffix = uniqueSuffix();
  const property = await Property.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imovel fechado ${suffix}`, internalCode: `CLS-${suffix}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  const c = await service.createMaintenanceCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado a fechar.' },
    tenant.userId,
    transaction
  );
  await service.updateMaintenanceCase(c.id, { status: 'RESOLVED' }, tenant.userId, transaction);
  await service.createWarrantyAction(c.id, { description: 'Visita tecnica.' }, tenant.userId, transaction);
  return service.updateMaintenanceCase(
    c.id,
    { status: 'CLOSED', rootCauseCode: 'MATERIAL_DEFECT', beforeMediaFileIds: BEFORE, afterMediaFileIds: AFTER },
    tenant.userId,
    transaction
  );
}

test('NEGATIVO: chamado fechado nao aceita retirar causa raiz (null, vazio) nem evidencias; nada e gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await closedCase(t);
    for (const payload of [
      { rootCauseCode: null },
      { rootCauseCode: '' },
      { beforeMediaFileIds: [] },
      { afterMediaFileIds: null },
      { beforeMediaFileIds: [''] },
      { afterMediaFileIds: ['   ', null] },
      { rootCauseCode: null, status: 'CLOSED' },
    ]) {
      await assert.rejects(
        () => service.updateMaintenanceCase(c.id, payload, tenant.userId, t),
        rejectsWith('MAINTENANCE_CASE_CLOSED_REQUIREMENTS', 422),
        JSON.stringify(payload)
      );
    }
    const fresh = await MaintenanceCase.findByPk(c.id, { transaction: t });
    assert.equal(fresh.status, 'CLOSED');
    assert.equal(fresh.rootCauseCode, 'MATERIAL_DEFECT');
    assert.deepEqual(fresh.beforeMediaFileIds, BEFORE);
    assert.deepEqual(fresh.afterMediaFileIds, AFTER);
  });
});

test('NEGATIVO: causa raiz invalida continua recusada em chamado fechado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await closedCase(t);
    await assert.rejects(() => service.updateMaintenanceCase(c.id, { rootCauseCode: 'INVENTADA' }, tenant.userId, t), rejectsWith('MAINTENANCE_CASE_ROOT_CAUSE_INVALID'));
  });
});

test('POSITIVO: chamado fechado aceita trocar a causa raiz por outra valida, trocar evidencias por outras e editar descricao/custos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await closedCase(t);
    const novo = await service.updateMaintenanceCase(
      c.id,
      { rootCauseCode: 'WORKMANSHIP', afterMediaFileIds: ['33333333-3333-3333-3333-333333333333'], description: 'Descricao revisada', laborCost: 120 },
      tenant.userId,
      t
    );
    assert.equal(novo.status, 'CLOSED');
    assert.equal(novo.rootCauseCode, 'WORKMANSHIP');
    assert.deepEqual(novo.afterMediaFileIds, ['33333333-3333-3333-3333-333333333333']);
    assert.equal(novo.description, 'Descricao revisada');
  });
});

test('POSITIVO: chamado ainda nao fechado continua podendo ficar sem causa raiz/evidencias (so o fechamento exige)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await closedCase(t);
    const aberto = await service.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: c.propertyId, description: 'Outro chamado.', rootCauseCode: 'MATERIAL_DEFECT' },
      tenant.userId,
      t
    );
    const upd = await service.updateMaintenanceCase(aberto.id, { rootCauseCode: null }, tenant.userId, t);
    assert.equal(upd.rootCauseCode, null);
    await assert.rejects(() => service.updateMaintenanceCase(aberto.id, { status: 'IN_PROGRESS' }, tenant.userId, t).then(() => service.updateMaintenanceCase(aberto.id, { status: 'RESOLVED' }, tenant.userId, t)).then(() => service.updateMaintenanceCase(aberto.id, { status: 'CLOSED' }, tenant.userId, t)), rejectsWith('MAINTENANCE_CASE_CLOSE_REQUIRES_ROOT_CAUSE'));
  });
});
