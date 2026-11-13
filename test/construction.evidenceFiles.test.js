'use strict';

// Matriz de fechamento do Marco 6 (10/11/2026) — DEFEITO ACHADO E CORRIGIDO: as evidências exigidas
// pelo Caderno (NC antes/depois, Change Order, chamado de garantia antes/depois, fotos do RDO com
// "hash/origem") aceitavam qualquer UUID, sem arquivo enviado por trás. Cada teste prova a recusa
// (CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND, nada gravado) e o controle positivo com arquivo real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { evidenceIds } = require('./constructionEvidenceFixture');
const { Nonconformity, ChangeOrder, MaintenanceCase, DailyReport, Company, File } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const changeOrdersService = require('../src/features/construction/changeOrders.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const propertiesService = require('../src/features/properties/properties.service');

const FAKE = '99999999-9999-4999-8999-999999999999';
let tenant;

before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const withTenant = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });
const isMissing = (field, id) => (err) => {
  assert.equal(err.code, 'CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND');
  assert.equal(err.statusCode, 400);
  assert.equal(err.details.field, field);
  assert.deepEqual(err.details.missingFileIds, [id]);
  return true;
};

async function project(t) {
  return projectsService.createProject(withTenant({ name: `QA M6 Evidencia ${uniqueSuffix()}` }), tenant.userId, t);
}

test('M6-109: abrir NC com evidência "antes" inexistente é recusado; com arquivo real abre', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await project(t);
    const base = { severity: 'HIGH', description: 'Fissura na viga', responsibleUserId: tenant.userId };
    await assert.rejects(
      () => nonconformitiesService.createNonconformity(p.id, withTenant({ ...base, beforeEvidenceFileIds: [FAKE] }), tenant.userId, t),
      isMissing('beforeEvidenceFileIds', FAKE)
    );
    assert.equal(await Nonconformity.count({ where: { projectId: p.id }, transaction: t }), 0, 'nada gravado');
    const nc = await nonconformitiesService.createNonconformity(p.id, withTenant({ ...base, beforeEvidenceFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    assert.equal(nc.status, 'OPEN');
  });
});

test('M6-62/M6-109: fechar NC com evidência "depois" inexistente é recusado e a NC continua aberta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await project(t);
    const nc = await nonconformitiesService.createNonconformity(
      p.id,
      withTenant({ severity: 'MEDIUM', description: 'Reboco solto', responsibleUserId: tenant.userId, beforeEvidenceFileIds: await evidenceIds(tenant, t) }),
      tenant.userId,
      t
    );
    await assert.rejects(() => nonconformitiesService.closeNonconformity(nc.id, { afterEvidenceFileIds: [FAKE] }, tenant.userId, t), isMissing('afterEvidenceFileIds', FAKE));
    assert.equal((await Nonconformity.findByPk(nc.id, { transaction: t })).status, 'OPEN');
    const closed = await nonconformitiesService.closeNonconformity(nc.id, { afterEvidenceFileIds: await evidenceIds(tenant, t) }, tenant.userId, t);
    assert.equal(closed.status, 'CLOSED');
  });
});

test('M6-06/M6-109: Change Order com evidência inexistente é recusado; com arquivo real é criado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await project(t);
    const co = (evidenceFileIds) =>
      changeOrdersService.createChangeOrder(
        p.id,
        withTenant({ reasonCode: 'ESCOPO', description: 'Aditivo de escopo', budgetImpact: 100, scheduleImpactDays: 2, evidenceFileIds, idempotencyKey: `co-${uniqueSuffix()}` }),
        tenant.userId,
        t
      );
    await assert.rejects(() => co([FAKE]), isMissing('evidenceFileIds', FAKE));
    assert.equal(await ChangeOrder.count({ where: { projectId: p.id }, transaction: t }), 0);
    assert.equal((await co(await evidenceIds(tenant, t))).status, 'PENDING_APPROVAL');
  });
});

test('M6-26/M6-109: chamado de garantia não abre nem fecha com foto inexistente; arquivo de outra empresa também não vale', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const property = await propertiesService.createProperty(withTenant({ title: `Imóvel QA ${s}`, internalCode: `QA-EV-${s}`, propertyType: 'RESIDENTIAL' }), tenant.userId, t);
    const p = await project(t);
    const open = (beforeMediaFileIds) =>
      maintenanceCasesService.createMaintenanceCase(
        withTenant({ propertyId: property.id, projectId: p.id, description: 'Infiltração', severity: 'HIGH', beforeMediaFileIds }),
        tenant.userId,
        t
      );
    await assert.rejects(() => open([FAKE]), isMissing('beforeMediaFileIds', FAKE));
    const wc = await open(await evidenceIds(tenant, t));
    await maintenanceCasesService.createWarrantyAction(wc.id, { description: 'Atendimento', cost: 10 }, tenant.userId, t);
    await maintenanceCasesService.updateMaintenanceCase(wc.id, { status: 'IN_PROGRESS' }, tenant.userId, t);
    await maintenanceCasesService.updateMaintenanceCase(wc.id, { status: 'RESOLVED' }, tenant.userId, t);

    // Arquivo real, mas de OUTRA empresa do mesmo grupo: para esta empresa ele não existe.
    const other = await Company.create({ groupId: tenant.groupId, name: `QA Outra ${s}`, status: 'ACTIVE' }, { transaction: t });
    const setCompany = (c) => sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c }, transaction: t });
    await setCompany(other.id);
    const [foreign] = await evidenceIds({ ...tenant, companyId: other.id }, t, 1, 'outra-empresa');
    assert.ok(await File.findByPk(foreign, { transaction: t }), 'o arquivo da outra empresa existe de verdade');
    await setCompany(tenant.companyId);
    const close = (afterMediaFileIds) =>
      maintenanceCasesService.updateMaintenanceCase(wc.id, { status: 'CLOSED', rootCauseCode: 'WORKMANSHIP', afterMediaFileIds }, tenant.userId, t);
    await assert.rejects(() => close([FAKE]), isMissing('afterMediaFileIds', FAKE));
    await assert.rejects(() => close([foreign]), isMissing('afterMediaFileIds', foreign));
    assert.equal((await MaintenanceCase.findByPk(wc.id, { transaction: t })).status, 'RESOLVED', 'chamado não fechou');
    assert.equal((await close(await evidenceIds(tenant, t))).status, 'CLOSED');
  });
});

test('M6-109: RDO com foto inexistente é recusado (criação e correção); com arquivo real grava', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await project(t);
    await assert.rejects(
      () => dailyReportsService.createDailyReport(p.id, withTenant({ reportDate: '2026-11-02', evidenceFileIds: [FAKE] }), tenant.userId, t),
      isMissing('evidenceFileIds', FAKE)
    );
    assert.equal(await DailyReport.count({ where: { projectId: p.id }, transaction: t }), 0);
    const rdo = await dailyReportsService.createDailyReport(p.id, withTenant({ reportDate: '2026-11-02', evidenceFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    await assert.rejects(() => dailyReportsService.correctDailyReport(rdo.id, { evidenceFileIds: ['nao-e-uuid'] }, tenant.userId, t), isMissing('evidenceFileIds', 'nao-e-uuid'));
    assert.equal(await DailyReport.count({ where: { projectId: p.id }, transaction: t }), 1, 'nenhuma revisão gravada');
  });
});
