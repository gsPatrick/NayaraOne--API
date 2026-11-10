'use strict';

// Matriz de fechamento do Marco 6 (10/11/2026): Caderno "Construção + Obras + Pós-obra" §11 — eventos
// mínimos. Até aqui só 9 dos 15 nomes tinham asserção em teste; este arquivo percorre a jornada inteira
// e confere, na Outbox, que CADA um dos 15 nomes foi gravado com o nome exato do livro, na mesma
// transação do dado de negócio. Também prova que o evento repetido de medição aprovada não gera
// segunda obrigação (§7, §12 "measurement.approved repetido → uma conta a pagar").

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { evidenceIds } = require('./constructionEvidenceFixture');
const { OutboxEvent, FinancialEntry, InventoryItem, InventoryLocation } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const materialRequestsService = require('../src/features/construction/materialRequests.service');
const inventoryMovementsService = require('../src/features/inventory/movements.service');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const propertiesService = require('../src/features/properties/properties.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { detectDelayedProjects } = require('../src/engines/jobs/projectDelayDetectionJob');

const MINIMOS = [
  'project.created', 'project.budget.approved', 'project.started', 'project.stage.completed', 'project.daily_log.created',
  'project.delay.detected', 'measurement.submitted', 'measurement.approved', 'material.requested', 'material.received',
  'nonconformity.opened', 'nonconformity.closed', 'project.delivered', 'warranty.case.opened', 'warranty.case.closed',
];

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});
const W = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

test('M6-69..M6-80: a jornada da obra grava na Outbox os 15 eventos mínimos do Caderno, com o nome exato', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const ontem = new Date(Date.now() - 86400000).toISOString();
    const project = await projectsService.createProject(
      W({ name: `QA M6 Eventos ${s}`, responsibleUserId: tenant.userId, managerUserId: tenant.userId, budgetAmount: 50000, startsAt: '2026-10-01', endsAtPlanned: ontem }),
      tenant.userId,
      t
    );
    await marginRulesService.createMarginRule(W({ minMarginPct: 10 }), tenant.userId, t);
    const budget = await budgetsService.createBudget(project.id, W({}), tenant.userId, t);
    await budgetLinesService.createBudgetLine(project.id, W({ budgetId: budget.id, category: 'Material', plannedAmount: 20000 }), tenant.userId, t);
    await budgetsService.approveBudget(budget.id, tenant.userId, t);

    const stage = await projectStagesService.createProjectStage(project.id, W({ name: 'Fundação', stageCode: `F-${s}`, sequence: 1, plannedPct: 100, plannedCost: 20000 }), tenant.userId, t);
    const local = await InventoryLocation.create({ ...W({}), name: `QA M6 Local ${s}`, locationType: 'WAREHOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    const item = await InventoryItem.create(
      { ...W({}), sku: `QA-M6-EV-${s}`, name: `QA M6 Cimento ${s}`, unitOfMeasure: 'UN', itemType: 'CONSUMABLE', averageCost: 10, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction: t }
    );
    await inventoryMovementsService.recordMovement(W({ inventoryItemId: item.id, movementType: 'IN', quantity: 100, destinationLocationId: local.id }), { userId: tenant.userId, canApprove: true }, t);
    const mr = await materialRequestsService.createMaterialRequest(project.id, W({ description: 'Cimento', quantity: 10, unit: 'UN', stageId: stage.id }), tenant.userId, t);
    await materialRequestsService.receiveMaterialRequest(mr.id, tenant.groupId, tenant.companyId, tenant.userId, t, { inventoryItemId: item.id, sourceLocationId: local.id, stageId: stage.id });

    await projectsService.transitionProject(project.id, 'READY', tenant.userId, t);
    await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, t);
    await dailyReportsService.createDailyReport(project.id, W({ reportDate: '2026-11-03', workforceCount: 4, evidenceFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    await detectDelayedProjects(t, new Date());

    const m = await stageMeasurementsService.createStageMeasurement(stage.id, W({ measuredPct: 100, measuredAt: '2026-11-03', items: [{ description: 'Fundação', quantity: 1, unitPrice: 18000 }] }), tenant.userId, t);
    await stageMeasurementsService.submitStageMeasurement(m.id, tenant.userId, t);
    await stageMeasurementsService.reviewStageMeasurement(m.id, { notes: 'Conferido' }, tenant.userId, t);
    const approved = await stageMeasurementsService.decideStageMeasurement(m.id, { decision: 'APPROVED' }, tenant.userId, t);

    const nc = await nonconformitiesService.createNonconformity(project.id, W({ severity: 'LOW', description: 'Rejunte', responsibleUserId: tenant.userId, beforeEvidenceFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    await nonconformitiesService.closeNonconformity(nc.id, { afterEvidenceFileIds: await evidenceIds(tenant, t) }, tenant.userId, t);
    await projectsService.transitionProject(project.id, 'FINAL_INSPECTION', tenant.userId, t);
    await projectsService.deliverProject(project.id, tenant.userId, t);

    const property = await propertiesService.createProperty(W({ title: `Imóvel QA ${s}`, internalCode: `QA-EVT-${s}`, propertyType: 'RESIDENTIAL' }), tenant.userId, t);
    const wc = await maintenanceCasesService.createMaintenanceCase(W({ propertyId: property.id, projectId: project.id, description: 'Infiltração', severity: 'MEDIUM', beforeMediaFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    await maintenanceCasesService.createWarrantyAction(wc.id, { description: 'Impermeabilização', cost: 100 }, tenant.userId, t);
    await maintenanceCasesService.updateMaintenanceCase(wc.id, { status: 'RESOLVED' }, tenant.userId, t);
    await maintenanceCasesService.updateMaintenanceCase(wc.id, { status: 'CLOSED', rootCauseCode: 'WORKMANSHIP', afterMediaFileIds: await evidenceIds(tenant, t) }, tenant.userId, t);

    const ids = [project.id, budget.id, stage.id, m.id, mr.id, nc.id, wc.id];
    const eventos = await OutboxEvent.findAll({ where: { companyId: tenant.companyId, eventType: { [Op.in]: MINIMOS } }, transaction: t });
    const daJornada = eventos.filter((e) => ids.includes(e.aggregateId) || ids.includes(e.payloadJson && (e.payloadJson.projectId || e.payloadJson.id)));
    const nomes = new Set(daJornada.map((e) => e.eventType));
    assert.deepEqual(MINIMOS.filter((n) => !nomes.has(n)), [], 'todo evento mínimo do Caderno precisa estar na Outbox');

    // measurement.approved repetido → uma única conta a pagar (o consumidor usa a chave da origem).
    await assert.rejects(() => stageMeasurementsService.decideStageMeasurement(m.id, { decision: 'APPROVED' }, tenant.userId, t), (e) => e.code === 'STAGE_MEASUREMENT_INVALID_STATUS');
    const { costCenterId } = await FinancialEntry.findByPk(approved.payableFinancialEntryId, { transaction: t });
    await assert.rejects(
      () => financialEntriesService.createFinancialEntry(
        W({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 18000, description: 'Reprocesso do evento', idempotencyKey: `measurement.payable:${m.id}`, constructionProjectId: project.id, costCenterId }),
        tenant.userId,
        t
      ),
      (e) => e.code === 'FINANCE_DUPLICATE_PAYMENT'
    );
    assert.equal(await FinancialEntry.count({ where: { idempotencyKey: `measurement.payable:${m.id}` }, transaction: t }), 1);
    assert.equal(daJornada.filter((e) => e.eventType === 'measurement.approved').length, 1, 'um único measurement.approved por medição');
  });
});
