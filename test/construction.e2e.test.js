'use strict';

// M6-98 — Jornada E2E completa de Obra: orçamento → material → diário → medição → pagamento →
// qualidade → entrega → pós-obra, numa única obra, em sequência real (não isolado por
// unidade). Cada etapa tem uma asserção real de estado, não só "não jogou erro" — é a prova de
// que o fluxo inteiro funciona encadeado, não só cada pedaço isolado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const materialRequestsService = require('../src/features/construction/materialRequests.service');
const inventoryMovementsService = require('../src/features/inventory/movements.service');
const { InventoryItem, InventoryLocation } = require('../src/models');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
const qualityChecklistService = require('../src/features/construction/qualityChecklist.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const projectHealthService = require('../src/features/construction/projectHealth.service');
const postObraHealthService = require('../src/features/construction/postObraHealth.service');
const propertiesService = require('../src/features/properties/properties.service');
const { FinancialEntry } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

// GAP REAL CORRIGIDO (CI quebrado, fresh DB sem seeds de real_estate.properties, 08/10/2026).
async function createProperty(transaction) {
  const suffix = uniqueSuffix();
  return propertiesService.createProperty(
    withTenant({
      title: `Imóvel E2E ${suffix}`,
      internalCode: `E2E-${suffix}`,
      propertyType: 'RESIDENTIAL',
    }),
    tenant.userId,
    transaction
  );
}

test('M6-98: jornada E2E completa — orçamento→material→diário→medição→pagamento→qualidade→entrega→pós-obra', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // 1. Criar obra (código auto-gerado, M6-01)
    const project = await projectsService.createProject(
      withTenant({
        name: `E2E Obra ${suffix}`,
        responsibleUserId: tenant.userId,
        budgetAmount: 50000,
        startsAt: '2026-10-01',
        endsAtPlanned: '2027-10-01',
      }),
      tenant.userId,
      transaction
    );
    assert.ok(project.code, 'obra deve ter code auto-gerado');
    assert.equal(project.status, 'PLANNED');

    // 2. Orçamento: criar agregado, linha, aprovar (vira baseline imutável)
    await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, transaction);
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    assert.equal(budget.status, 'DRAFT');
    await budgetLinesService.createBudgetLine(
      project.id,
      withTenant({ budgetId: budget.id, category: 'Material', plannedAmount: 20000 }),
      tenant.userId,
      transaction
    );
    const approvedBudget = await budgetsService.approveBudget(budget.id, tenant.userId, transaction);
    assert.equal(approvedBudget.status, 'APPROVED');
    // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 9, Frente C — teste mente, 09/10/2026):
    // `assert.ok(x > 0)` deixaria passar qualquer bug de cálculo do baseline (soma duplicada,
    // multiplicação errada) desde que o resultado fosse positivo. Única BudgetLine criada tem
    // plannedAmount=20000 — o valor exato precisa bater.
    assert.equal(Number(approvedBudget.baselineAmount), 20000, 'baseline deve estar congelada com o valor exato da única linha criada');

    // 3. Requisição de material: criar e marcar recebida
    const materialRequest = await materialRequestsService.createMaterialRequest(
      project.id,
      withTenant({ description: 'Cimento CP-II', quantity: 100, unit: 'saco' }),
      tenant.userId,
      transaction
    );
    assert.equal(materialRequest.status, 'REQUESTED');
    // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07): receber agora exige item/local
    // real do Estoque — cria um item+local mínimo com saldo pra este E2E.
    const stockLocation = await InventoryLocation.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `HOMO QA E2E Local ${suffix}`, locationType: 'WAREHOUSE', createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const stockItem = await InventoryItem.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, sku: `HOMO-E2E-${suffix}`, name: `HOMO QA E2E Item ${suffix}`, unitOfMeasure: 'UN', itemType: 'CONSUMABLE', averageCost: 10, allowNegativeStock: true, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    await inventoryMovementsService.recordMovement(
      { groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: stockItem.id, movementType: 'IN', quantity: 500, destinationLocationId: stockLocation.id },
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    const receivedRequest = await materialRequestsService.receiveMaterialRequest(materialRequest.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, {
      inventoryItemId: stockItem.id,
      sourceLocationId: stockLocation.id,
    });
    assert.equal(receivedRequest.status, 'RECEIVED');

    // 4. Iniciar obra — o orçamento aprovado no passo 2 já avançou PLANNED -> BUDGETED
    // automaticamente; segue READY -> ACTIVE (M6-18, máquina de estados de 8 estágios).
    const afterBudget = await projectsService.getProject(project.id, transaction);
    assert.equal(afterBudget.status, 'BUDGETED');
    const ready = await projectsService.transitionProject(project.id, 'READY', tenant.userId, transaction);
    assert.equal(ready.status, 'READY');
    const started = await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
    assert.equal(started.status, 'ACTIVE');

    // 5. Diário de obra (RDO)
    const report = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate: '2026-09-30', weather: 'Ensolarado', workforceCount: 8 }),
      tenant.userId,
      transaction
    );
    assert.ok(report.id);

    // 6. Etapa
    const stage = await projectStagesService.createProjectStage(
      project.id,
      withTenant({ name: 'Fundação', stageCode: 'FUND-01', sequence: 1, plannedPct: 100, plannedCost: 20000 }),
      tenant.userId,
      transaction
    );
    assert.equal(stage.stageCode, 'FUND-01');

    // 7. Medição: criar (DRAFT) -> submeter -> revisar -> aprovar (dispara pagamento real)
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      withTenant({ measuredPct: 100, measuredAt: '2026-09-30', items: [{ description: 'Fundação concluída', quantity: 1, unitPrice: 18000 }] }),
      tenant.userId,
      transaction
    );
    assert.equal(measurement.status, 'DRAFT');
    const submitted = await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, transaction);
    assert.equal(submitted.status, 'SUBMITTED');
    const reviewed = await stageMeasurementsService.reviewStageMeasurement(measurement.id, { notes: 'Conferido em campo' }, tenant.userId, transaction);
    assert.equal(reviewed.status, 'REVIEWED');
    const approved = await stageMeasurementsService.decideStageMeasurement(measurement.id, { decision: 'APPROVED' }, tenant.userId, transaction);
    assert.equal(approved.status, 'PAYABLE');
    assert.ok(approved.payableFinancialEntryId, 'medição aprovada deve gerar lançamento financeiro real');

    const payable = await FinancialEntry.findByPk(approved.payableFinancialEntryId, { transaction });
    assert.ok(payable, 'o lançamento financeiro tem que existir de verdade no banco');
    assert.equal(payable.constructionProjectId, project.id, 'lançamento carrega a dimensão project_id (M6-97)');

    // 8. Qualidade: item OK
    const qualityItem = await qualityChecklistService.createQualityItem(
      project.id,
      withTenant({ item: 'Verificar prumo da fundação', category: 'ESTRUTURA' }),
      tenant.userId,
      transaction
    );
    const checkedItem = await qualityChecklistService.checkQualityItem(qualityItem.id, { status: 'OK' }, tenant.userId, transaction);
    assert.equal(checkedItem.status, 'OK');

    // 9. Confirmar ausência de não conformidade crítica antes de completar/entregar
    const openNcs = await nonconformitiesService.listNonconformities(project.id, transaction, { status: 'OPEN' });
    assert.equal(openNcs.filter((nc) => nc.severity === 'CRITICAL').length, 0, 'não deve haver NC crítica aberta');

    // 10. Entrar em inspeção final e entregar a obra (gate real: bloquearia se houvesse NC
    // crítica) — M6-18: a mesma chamada de deliverProject já avança DELIVERED -> WARRANTY.
    const finalInspection = await projectsService.transitionProject(project.id, 'FINAL_INSPECTION', tenant.userId, transaction);
    assert.equal(finalInspection.status, 'FINAL_INSPECTION');
    assert.ok(finalInspection.actualEndDate, 'actualEndDate deve ser preenchido automaticamente ao entrar em inspeção final');
    const delivered = await projectsService.deliverProject(project.id, tenant.userId, transaction);
    assert.equal(delivered.status, 'WARRANTY');

    // 11. Read model de saúde da obra em andamento — confere que reflete o que foi construído.
    // O lançamento gerado pela medição nasce PENDING (ainda não foi pago de fato) —
    // `actualFinancialCost` só soma o que já foi liquidado (SETTLED), então o valor esperado
    // aqui é `payablePendingTotal`, não `actualFinancialCost`.
    const health = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.ok(health.kpis.payablePendingTotal > 0, 'valor a pagar pendente deve refletir a medição aprovada');

    // 12. Pós-obra: abrir caso de garantia vinculado à obra ENTREGUE, registrar atendimento, fechar
    const property = await createProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      withTenant({ propertyId: property.id, projectId: project.id, description: 'Infiltração pós-entrega', severity: 'MEDIUM' }),
      tenant.userId,
      transaction
    );
    assert.equal(warrantyCase.projectId, project.id);
    const action = await maintenanceCasesService.createWarrantyAction(
      warrantyCase.id,
      { description: 'Aplicado impermeabilizante', cost: 350 },
      tenant.userId,
      transaction
    );
    assert.ok(action.id);
    await maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'RESOLVED' }, tenant.userId, transaction);
    const closedCase = await maintenanceCasesService.updateMaintenanceCase(
      warrantyCase.id,
      {
        status: 'CLOSED',
        rootCauseCode: 'WORKMANSHIP',
        beforeMediaFileIds: ['99999999-9999-9999-9999-999999999999'],
        afterMediaFileIds: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
      },
      tenant.userId,
      transaction
    );
    assert.equal(closedCase.status, 'CLOSED');

    // 13. Read model separado de pós-obra (M6-100) — confirma que enxerga o caso fechado
    const postObraHealth = await postObraHealthService.getPostObraHealth(project.id, transaction);
    assert.equal(postObraHealth.closedCases, 1);
    assert.equal(postObraHealth.totalWarrantyActions, 1);
    // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 9, Frente C — teste mente, 09/10/2026):
    // `>= 350` deixaria passar um bug de duplicação de custo (ex. somar o WarrantyAction duas
    // vezes, dar 700) sem ser detectado. Única ação criada tem cost=350 — o valor exato precisa
    // bater.
    assert.equal(Number(postObraHealth.totalLaborCost), 350, 'custo da ação de garantia deve entrar no total com o valor exato, sem duplicar');

    // 14. Fechamento definitivo da obra (M6-18: WARRANTY -> CLOSED) — último estágio da máquina
    // de estados de 8 estágios, só alcançável porque o único caso de garantia já está CLOSED.
    const closedProject = await projectsService.closeProjectWarranty(project.id, tenant.userId, transaction);
    assert.equal(closedProject.status, 'CLOSED');

    // 15. NAY Obras (M6-101) — componente nomeado, resumo determinístico real sobre os dados
    // construídos ao longo de toda a jornada.
    const nayObrasService = require('../src/features/construction/nayObras.service');
    const nayPostObraSummary = await nayObrasService.summarizePostObra(project.id, transaction);
    assert.equal(nayPostObraSummary.component, 'NAY Obras');
    assert.equal(nayPostObraSummary.summary.closedCases, 1);
    assert.deepEqual(nayPostObraSummary.decisionsMade, [], 'NAY nunca decide nada sozinha (M6-27)');
  });
});
