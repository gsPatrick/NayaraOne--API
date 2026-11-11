'use strict';

/**
 * Fixtures do drill de restore de Obras (Marco 6, Caderno §13 DoD "testes adversariais/RLS/
 * concorrência/restore verdes"). Tudo pelos SERVIÇOS REAIS de Obras, como a role de runtime (RLS
 * real), só num banco "drill_*" local (drillGuard). Uma obra percorre a jornada inteira: orçamento
 * aprovado (baseline) + Change Order aprovado, requisição recebida e devolvida, diário com correção
 * (append-only), medição até PAYABLE (conta a pagar real), NC aberta e fechada com evidência, perda
 * e estorno, entrega e chamado de garantia fechado com fotos antes/depois.
 *
 * Uso (só pelo orquestrador constructionFullDrill.js): node scripts/restoreDrill/seedConstructionFixtures.js --out <fixtures.json>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertDrillDatabase } = require('./drillGuard');
const { retratoDaSaude } = require('./verifyConstructionAppRead');

assertDrillDatabase(process.env.DATABASE_URL, 'seedConstructionFixtures');

const fx = require('../lib/inventoryFixtures');

const SRC = path.join(__dirname, '..', '..', 'src');
const svc = (name) => require(path.join(SRC, 'features', 'construction', `${name}.service`));

async function main() {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  const ctx = fx.load();
  const tenant = await fx.getSeedTenant(ctx);
  const T = (fn) => fx.inTenant(ctx, tenant, fn);
  const W = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });
  const s = crypto.randomBytes(3).toString('hex');
  const foto = (t, label) => ctx.filesService.uploadFile(
    W({ fileName: `${label}-${s}.jpg`, mimeType: 'image/jpeg', contentBase64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(32)]).toString('base64'), category: 'CONSTRUCTION_EVIDENCE' }),
    tenant.userId, t
  ).then((f) => f.id);

  const f = {};
  await T(async (t) => {
    const project = await svc('projects').createProject(W({ name: `Drill Obra Residencial ${s}`, responsibleUserId: tenant.userId, managerUserId: tenant.userId, budgetAmount: 60000, startsAt: '2026-10-01', endsAtPlanned: '2027-06-30' }), tenant.userId, t);
    await svc('marginRules').createMarginRule(W({ minMarginPct: 10 }), tenant.userId, t);
    const budget = await svc('budgets').createBudget(project.id, W({}), tenant.userId, t);
    await svc('budgetLines').createBudgetLine(project.id, W({ budgetId: budget.id, category: 'Estrutura', plannedAmount: 30000 }), tenant.userId, t);
    await svc('budgetLines').createBudgetLine(project.id, W({ budgetId: budget.id, category: 'Acabamento', plannedAmount: 12000 }), tenant.userId, t);
    const approved = await svc('budgets').approveBudget(budget.id, tenant.userId, t);
    const co = await svc('changeOrders').createChangeOrder(project.id, W({ reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço de viga', budgetImpact: 1500, scheduleImpactDays: 3, evidenceFileIds: [await foto(t, 'aditivo')], idempotencyKey: `drill-co-${s}` }), tenant.userId, t);
    await svc('changeOrders').decideChangeOrder(co.id, { decision: 'APPROVE' }, tenant.userId, t);
    Object.assign(f, { projectId: project.id, budgetId: budget.id, baselineAtApproval: Number(approved.baselineAmount), changeOrderId: co.id, changeOrderImpact: Number(co.budgetImpact) });
  });

  await T(async (t) => {
    const { InventoryItem, InventoryLocation } = ctx.models;
    const stage = await svc('projectStages').createProjectStage(f.projectId, W({ name: 'Estrutura', stageCode: `EST-${s}`, sequence: 1, plannedPct: 100, plannedCost: 30000 }), tenant.userId, t);
    const local = await InventoryLocation.create({ ...W({}), name: `Drill Almox Obras ${s}`, locationType: 'WAREHOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    const item = await InventoryItem.create({ ...W({}), sku: `DRILL-OBR-${s}`, name: `Drill Cimento Obras ${s}`, unitOfMeasure: 'UN', itemType: 'CONSUMABLE', averageCost: 32, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    await ctx.movementsService.recordMovement(W({ inventoryItemId: item.id, movementType: 'IN', quantity: 200, unitCost: 32, destinationLocationId: local.id }), { userId: tenant.userId, canApprove: true }, t);
    const mrS = svc('materialRequests');
    const mr = await mrS.createMaterialRequest(f.projectId, W({ description: 'Cimento CP-II', quantity: 40, unit: 'UN', stageId: stage.id }), tenant.userId, t);
    await mrS.receiveMaterialRequest(mr.id, tenant.groupId, tenant.companyId, tenant.userId, t, { inventoryItemId: item.id, sourceLocationId: local.id, stageId: stage.id });
    await mrS.returnMaterialRequest(mr.id, tenant.groupId, tenant.companyId, { inventoryItemId: item.id, destinationLocationId: local.id, quantity: 5, conditionCode: 'REUSABLE' }, tenant.userId, t);
    Object.assign(f, { stageId: stage.id, materialRequestId: mr.id, inventoryItemId: item.id, locationId: local.id });
  });

  await T(async (t) => {
    const p = svc('projects');
    await p.transitionProject(f.projectId, 'READY', tenant.userId, t);
    await p.transitionProject(f.projectId, 'ACTIVE', tenant.userId, t);
    const rdo = await svc('dailyReports').createDailyReport(f.projectId, W({ reportDate: '2026-11-04', shiftCode: 'MANHA', workforceCount: 9, servicesPerformed: 'Concretagem da laje', evidenceFileIds: [await foto(t, 'rdo')] }), tenant.userId, t);
    const rev = await svc('dailyReports').correctDailyReport(rdo.id, { workforceCount: 10, occurrences: 'Correção: faltou um armador na contagem' }, tenant.userId, t);
    const m = svc('stageMeasurements');
    const med = await m.createStageMeasurement(f.stageId, W({ measuredPct: 100, measuredAt: '2026-11-04', items: [{ description: 'Estrutura concluída', quantity: 1, unitPrice: 27500 }] }), tenant.userId, t);
    await m.submitStageMeasurement(med.id, tenant.userId, t);
    await m.reviewStageMeasurement(med.id, { notes: 'Conferido em campo' }, tenant.userId, t);
    const ok = await m.decideStageMeasurement(med.id, { decision: 'APPROVED' }, tenant.userId, t);
    Object.assign(f, { rdoOriginalId: rdo.id, rdoRevisionId: rev.id, measurementId: med.id, payableId: ok.payableFinancialEntryId, measurementTotal: Number(ok.totalAmount) });
  });

  await T(async (t) => {
    const nc = await svc('nonconformities').createNonconformity(f.projectId, W({ severity: 'HIGH', description: 'Desaprumo de pilar', responsibleUserId: tenant.userId, beforeEvidenceFileIds: [await foto(t, 'nc-antes')] }), tenant.userId, t);
    await svc('nonconformities').closeNonconformity(nc.id, { afterEvidenceFileIds: [await foto(t, 'nc-depois')] }, tenant.userId, t);
    const loss = await svc('lossRecords').createLossRecord(f.projectId, W({ materialDescription: 'Cimento empedrado', quantity: 4, estimatedValue: 128, reason: 'Umidade no depósito', idempotencyKey: `drill-loss-${s}` }), tenant.userId, t);
    const est = await svc('lossRecords').returnLossRecord(loss.id, { quantity: 1, idempotencyKey: `drill-loss-ret-${s}` }, tenant.userId, t);
    Object.assign(f, { nonconformityId: nc.id, lossRecordId: loss.id, lossReturnId: est.id });
  });

  await T(async (t) => {
    const p = svc('projects');
    await p.transitionProject(f.projectId, 'FINAL_INSPECTION', tenant.userId, t);
    await p.deliverProject(f.projectId, tenant.userId, t);
    const property = await ctx.models.Property.create({ ...W({}), title: `Drill Casa ${s}`, internalCode: `DRILL-M6-${s}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    const mc = svc('maintenanceCases');
    const wc = await mc.createMaintenanceCase(W({ propertyId: property.id, projectId: f.projectId, description: 'Infiltração na laje', severity: 'MEDIUM', category: 'WATERPROOFING', beforeMediaFileIds: [await foto(t, 'garantia-antes')] }), tenant.userId, t);
    await mc.createWarrantyAction(wc.id, { description: 'Manta asfáltica refeita', cost: 450 }, tenant.userId, t);
    await mc.updateMaintenanceCase(wc.id, { status: 'RESOLVED' }, tenant.userId, t);
    await mc.updateMaintenanceCase(wc.id, { status: 'CLOSED', rootCauseCode: 'WORKMANSHIP', afterMediaFileIds: [await foto(t, 'garantia-depois')] }, tenant.userId, t);
    Object.assign(f, { warrantyCaseId: wc.id, propertyId: property.id });
  });

  // Retrato de ANTES do backup, calculado pelo serviço real na origem: a verificação compara com o que a API lê do banco restaurado
  // (verifyConstructionAppRead.js) e com a baseline restaurada (fiel à origem, qualquer que seja a regra do aditivo).
  await T(async (t) => {
    const health = require(path.join(SRC, 'features', 'construction', 'projectHealth.service'));
    f.saudeNoBackup = retratoDaSaude(await health.getProjectHealth(f.projectId, t));
    f.baselineNoBackup = Number((await ctx.models.Budget.findByPk(f.budgetId, { transaction: t })).baselineAmount);
    f.statusNoBackup = (await ctx.models.Project.findByPk(f.projectId, { transaction: t })).status;
  });

  f.tenant = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  fs.writeFileSync(out, JSON.stringify(f, null, 2));
  console.log(`fixtures de Obras: obra ${f.projectId} (orçamento, aditivo, requisição+devolução, RDO+correção, medição PAYABLE, NC, perda+estorno, entrega, garantia fechada)`);
  await ctx.sequelize.close();
}

main().catch((err) => {
  console.error(`seedConstructionFixtures: ${err.code || ''} ${err.message}`);
  process.exit(1);
});
