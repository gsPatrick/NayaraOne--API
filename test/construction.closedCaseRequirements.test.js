'use strict';

/**
 * Auditoria da cliente, Marco 6 (achado 4): depois de FECHADO, Editar permitia retirar a causa
 * raiz (ou as evidencias) e conservar o status Fechado. Os requisitos de fechamento valem em
 * qualquer atualizacao de um chamado fechado.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { evidenceIds } = require('./constructionEvidenceFixture');
const { Property, MaintenanceCase } = require('../src/models');
const service = require('../src/features/construction/maintenanceCases.service');
const AppError = require('../src/utils/AppError');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

// Fotos reais (core.files) — desde 10/11/2026 os serviços de Obras recusam ID de arquivo inexistente.
let BEFORE;
let AFTER;

const rejectsWith = (code, status) => (err) => {
  assert.ok(err instanceof AppError);
  assert.equal(err.code, code);
  if (status) assert.equal(err.statusCode, status);
  return true;
};

async function closedCase(transaction) {
  const suffix = uniqueSuffix();
  BEFORE = await evidenceIds(tenant, transaction, 1, 'antes');
  AFTER = await evidenceIds(tenant, transaction, 1, 'depois');
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

test('NEGATIVO: chamado fechado nao aceita trocar a foto obrigatoria por um ID sem arquivo (CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND); nada e gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await closedCase(t);
    const semArquivo = '33333333-3333-4333-8333-333333333333';
    for (const payload of [{ afterMediaFileIds: [semArquivo] }, { beforeMediaFileIds: [semArquivo] }]) {
      await assert.rejects(() => service.updateMaintenanceCase(c.id, payload, tenant.userId, t), rejectsWith('CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND', 400), JSON.stringify(payload));
    }
    const fresh = await MaintenanceCase.findByPk(c.id, { transaction: t });
    assert.deepEqual(fresh.beforeMediaFileIds, BEFORE);
    assert.deepEqual(fresh.afterMediaFileIds, AFTER);
  });
});

test('POSITIVO: chamado fechado aceita trocar a causa raiz por outra valida, trocar evidencias por outras e editar descricao/custos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await closedCase(t);
    const outraFoto = await evidenceIds(tenant, t, 1, 'depois-nova');
    const novo = await service.updateMaintenanceCase(
      c.id,
      { rootCauseCode: 'WORKMANSHIP', afterMediaFileIds: outraFoto, description: 'Descricao revisada', laborCost: 120 },
      tenant.userId,
      t
    );
    assert.equal(novo.status, 'CLOSED');
    assert.equal(novo.rootCauseCode, 'WORKMANSHIP');
    assert.deepEqual(novo.afterMediaFileIds, outraFoto);
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
