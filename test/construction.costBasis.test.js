'use strict';

// Matriz de fechamento do Marco 6 (10/11/2026) — lacuna do Caderno §5 ("actual_financial_cost" sem dizer se é
// caixa ou competência) vira o parâmetro da empresa construction.custo_realizado.base (CAIXA padrão | COMPETENCIA).
// Prova os dois modos com o caso da captura ao vivo (R$ 61.600,00 de medições aprovadas a pagar), a ausência de
// dupla contagem depois do pagamento, o bloqueio de margem obedecendo à base, o painel agregado e a gravação do
// parâmetro (validação, permissão e auditoria com antes/depois).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, settleFinancialEntryWithApproval } = require('./testHelpers');
const { setThresholds, createMember } = require('./constructionM6vFixture');
const { AuditLog } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const changeOrdersService = require('../src/features/construction/changeOrders.service');
const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
const projectHealthService = require('../src/features/construction/projectHealth.service');
const dashboardService = require('../src/features/construction/dashboard.service');
const settingsService = require('../src/features/settings/settings.service');
const { KEY } = require('../src/features/construction/costBasis');
const { evidenceIds } = require('./constructionEvidenceFixture');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});
const W = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });
const setBase = (base, t, permissions) => settingsService.upsertSetting(KEY, base, W({}), tenant.userId, t, permissions ? { permissions } : {});

/** Obra com baseline de R$ 80.000,00 e duas medições aprovadas a pagar que somam R$ 61.600,00 (caso da captura). */
async function obraComMedicoesAPagar(t, { alvenaria = 20400 } = {}) {
  const s = uniqueSuffix();
  const project = await projectsService.createProject(W({ name: `QA M6 Base de custo ${s}`, budgetAmount: 120000 }), tenant.userId, t);
  await marginRulesService.createMarginRule(W({ minMarginPct: 10 }), tenant.userId, t);
  const budget = await budgetsService.createBudget(project.id, W({}), tenant.userId, t);
  await budgetLinesService.createBudgetLine(project.id, W({ budgetId: budget.id, category: 'Fundação', plannedAmount: 45000 }), tenant.userId, t);
  await budgetLinesService.createBudgetLine(project.id, W({ budgetId: budget.id, category: 'Alvenaria', plannedAmount: 35000 }), tenant.userId, t);
  await budgetsService.approveBudget(budget.id, tenant.userId, t);
  const stage = (name, seq) => projectStagesService.createProjectStage(project.id, W({ name, stageCode: `${name.slice(0, 3).toUpperCase()}-${s}`, sequence: seq, plannedPct: 100, plannedCost: 40000 }), tenant.userId, t);
  const st1 = await stage('Fundação', 1);
  const st2 = await stage('Alvenaria', 2);
  const medir = async (st, pct, items) => {
    const m = await stageMeasurementsService.createStageMeasurement(st.id, W({ measuredPct: pct, measuredAt: '2026-11-09', items }), tenant.userId, t);
    await stageMeasurementsService.submitStageMeasurement(m.id, tenant.userId, t);
    await stageMeasurementsService.reviewStageMeasurement(m.id, { notes: 'Conferido' }, tenant.userId, t);
    return stageMeasurementsService.decideStageMeasurement(m.id, { decision: 'APPROVED' }, tenant.userId, t);
  };
  const m1 = await medir(st1, 100, [{ description: 'Sapatas', quantity: 8, unitPrice: 4400 }, { description: 'Baldrame', quantity: 1, unitPrice: 6000 }]); // 41.200
  const m2 = await medir(st2, 50, [{ description: 'Alvenaria do térreo', quantity: 1, unitPrice: alvenaria }]); // 20.400 (padrão)
  return { project, m1, m2 };
}

test('M6-42/M6-22: CAIXA (padrão) não conta medição aprovada a pagar; COMPETENCIA conta os R$ 61.600,00 no custo, na projeção e na margem', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { project } = await obraComMedicoesAPagar(t);
    const caixa = await projectHealthService.getProjectHealth(project.id, t);
    assert.equal(caixa.costBasis.base, 'CAIXA', 'sem parâmetro gravado vale o padrão CAIXA');
    assert.equal(caixa.costBasis.pendingApprovedMeasurementsCost, 61600, 'as medições a pagar aparecem para transparência');
    assert.equal(caixa.costBasis.openPayablesCost, 61600);
    assert.equal(caixa.actualFinancialCost, 0, 'CAIXA: nada pago ainda');
    assert.equal(caixa.kpis.payablePendingTotal, 61600);
    assert.equal(caixa.projectedTotalCost, 0);
    assert.equal(caixa.projectedMargin, 80000);

    await setBase('COMPETENCIA', t);
    const comp = await projectHealthService.getProjectHealth(project.id, t);
    assert.equal(comp.costBasis.base, 'COMPETENCIA');
    assert.equal(comp.costBasis.includedInActualFinancialCost, true);
    assert.equal(comp.actualFinancialCost, 61600, 'COMPETENCIA: medições aprovadas a pagar entram no custo realizado');
    // progresso físico médio 75% (100% + 50%): EAC = 61.600 / 0,75 = 82.133,33
    assert.equal(comp.projectedTotalCost, 82133.33);
    assert.equal(comp.projectedMargin, -2133.33);
    assert.equal(comp.belowMinMargin, true, 'a margem abaixo da regra passa a ser sinalizada');

    await setBase('CAIXA', t);
    assert.equal((await projectHealthService.getProjectHealth(project.id, t)).actualFinancialCost, 0, 'voltar para CAIXA restaura o cálculo anterior');
  });
});

test('M6-42/M6-107: COMPETENCIA também conta o desconto/ressarcimento de garantia aprovado e ainda a pagar (captura: 56.200 de medições + 5.400 de garantia = 61.600)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await setThresholds(tenant, t, { WARRANTY_RESOLUTION: 1000 }); // alçada é configuração da empresa (DI-M6V-6): sem padrão no código
    const aprovador = await createMember(tenant, t); // quem propõe não aprova (M6-107)
    // Medição da Alvenaria de R$ 15.000,00, como na captura: 41.200 + 15.000 = 56.200 de medições.
    const { project } = await obraComMedicoesAPagar(t, { alvenaria: 15000 });
    const property = await require('../src/features/properties/properties.service').createProperty(W({ title: `Imóvel QA ${uniqueSuffix()}`, internalCode: `QA-CB-${uniqueSuffix()}`, propertyType: 'RESIDENTIAL' }), tenant.userId, t);
    const mc = require('../src/features/construction/maintenanceCases.service');
    const wc = await mc.createMaintenanceCase(W({ propertyId: property.id, projectId: project.id, description: 'Infiltração', severity: 'HIGH', beforeMediaFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    await mc.proposeWarrantyResolution(wc.id, { resolutionType: 'DISCOUNT', resolutionAmount: 400 }, tenant.userId, t);
    const wc2 = await mc.createMaintenanceCase(W({ propertyId: property.id, projectId: project.id, description: 'Trinca', severity: 'CRITICAL', beforeMediaFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    await mc.proposeWarrantyResolution(wc2.id, { resolutionType: 'REIMBURSEMENT', resolutionAmount: 5000 }, tenant.userId, t);
    await mc.approveWarrantyResolution(wc2.id, aprovador.id, t);
    const caixa = await projectHealthService.getProjectHealth(project.id, t);
    assert.equal(caixa.kpis.payablePendingTotal, 61600, 'mesmo total a pagar da captura');
    assert.equal(caixa.costBasis.openPayablesCost, 61600);
    assert.equal(caixa.costBasis.pendingApprovedMeasurementsCost, 56200);
    assert.equal(caixa.actualFinancialCost, 0);
    await setBase('COMPETENCIA', t);
    assert.equal((await projectHealthService.getProjectHealth(project.id, t)).actualFinancialCost, 61600);
  });
});

test('M6-42: depois do pagamento a medição não é contada duas vezes (CAIXA e COMPETENCIA convergem)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { project, m1 } = await obraComMedicoesAPagar(t);
    await settleFinancialEntryWithApproval(tenant, m1.payableFinancialEntryId, tenant.userId, t);
    const caixa = await projectHealthService.getProjectHealth(project.id, t);
    assert.equal(caixa.actualFinancialCost, 41200, 'CAIXA: só a medição paga');
    assert.equal(caixa.costBasis.pendingApprovedMeasurementsCost, 20400);
    await setBase('COMPETENCIA', t);
    const comp = await projectHealthService.getProjectHealth(project.id, t);
    assert.equal(comp.actualFinancialCost, 61600, 'COMPETENCIA: paga (41.200) + a pagar (20.400), sem somar a paga de novo');
  });
});

test('M6-23: o bloqueio de margem (modo BLOQUEIO) obedece à base do custo realizado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { project } = await obraComMedicoesAPagar(t);
    await marginRulesService.createMarginRule(W({ minMarginPct: 10, enforcementMode: 'BLOCK' }), tenant.userId, t);
    const co = async (k) => changeOrdersService.createChangeOrder(project.id, W({ reasonCode: 'ESCOPO', description: 'Aditivo', budgetImpact: 500, scheduleImpactDays: 0, evidenceFileIds: await evidenceIds(tenant, t), idempotencyKey: `cb-${k}-${uniqueSuffix()}` }), tenant.userId, t);
    const emCaixa = await co('a');
    assert.equal((await changeOrdersService.decideChangeOrder(emCaixa.id, { decision: 'APPROVE' }, tenant.userId, t)).status, 'APPROVED', 'CAIXA: margem projetada alta, aprova');
    await setBase('COMPETENCIA', t);
    const emCompetencia = await co('b');
    await assert.rejects(() => changeOrdersService.decideChangeOrder(emCompetencia.id, { decision: 'APPROVE' }, tenant.userId, t), (e) => e.code === 'CHANGE_ORDER_APPROVAL_BLOCKED_BY_MARGIN_RULE');
  });
});

test('M6-99/M6-100: o painel agregado de Obras usa a mesma base', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await obraComMedicoesAPagar(t);
    const caixa = (await dashboardService.getConstructionDashboard(W({}), t)).obras;
    assert.equal(caixa.costBasis.base, 'CAIXA');
    assert.ok(caixa.costBasis.pendingApprovedMeasurementsTotal >= 61600);
    assert.ok(caixa.costBasis.openPayablesTotal >= caixa.costBasis.pendingApprovedMeasurementsTotal);
    await setBase('COMPETENCIA', t);
    const comp = (await dashboardService.getConstructionDashboard(W({}), t)).obras;
    assert.equal(comp.costBasis.base, 'COMPETENCIA');
    assert.equal(Math.round((comp.actualFinancialCostTotal - caixa.actualFinancialCostTotal) * 100) / 100, caixa.costBasis.openPayablesTotal, 'a diferença entre as bases é exatamente o valor em aberto das obrigações das obras');
  });
});

test('parâmetro construction.custo_realizado.base: valida o valor, exige construction:approve e audita antes/depois', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(() => setBase('REGIME_X', t), (e) => e.code === 'SETTING_INVALID_VALUE');
    await assert.rejects(() => setBase('COMPETENCIA', t, ['settings:update', 'construction:read']), (e) => e.code === 'SETTING_PERMISSION_REQUIRED' && e.details.required === 'construction:approve');
    const row = await setBase('COMPETENCIA', t, ['settings:update', 'construction:approve']);
    await setBase('CAIXA', t, ['settings:update', 'construction:approve']);
    const logs = await AuditLog.findAll({ where: { entityId: row.id }, order: [['occurredAt', 'ASC']], transaction: t });
    assert.deepEqual(logs.map((l) => l.action), ['settings.create', 'settings.update']);
    assert.equal(logs[0].beforeJson, null, 'criação: antes não existia');
    assert.equal(logs[0].afterJson.value, 'COMPETENCIA');
    assert.equal(logs[1].beforeJson.value, 'COMPETENCIA');
    assert.equal(logs[1].afterJson.value, 'CAIXA');
  });
});
