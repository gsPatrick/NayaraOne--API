'use strict';

// ITEM 6 (auditoria pós-Marco 6, fechamento de gaps): os 3 paths canônicos abaixo
// (POST /projects/:id/measurements, POST /measurements/:id/approve, POST /warranty-cases)
// só eram exercitados chamando o service direto (ou via rota irmã /stages/:id/measurements),
// nunca com uma requisição HTTP real contra o Express app (auth real via JWT + middleware de
// tenant real + RLS real). Este arquivo sobe o app de verdade (`app.listen(0)`) e usa
// `fetch` nativo do Node para bater exatamente no path exigido pela fonte, com o mesmo
// Authorization: Bearer <jwt> que um cliente real usaria.
//
// Diferente do resto da suíte (que roda dentro de uma transação com rollback — ver
// testHelpers.withRollbackTenantTransaction), uma requisição HTTP real abre/comita sua
// PRÓPRIA transação dentro do middleware de tenant (src/middlewares/tenant.middleware.js).
// Os dados ficam persistidos de verdade no banco de dev — por isso o `after()` deste arquivo
// limpa explicitamente (hard delete) tudo o que foi criado, na ordem inversa de FK.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// `app.js` (diferente de uma exportação "pura" de app Express) chama `app.listen(...)` de
// forma incondicional no topo do próprio módulo (não há guarda de NODE_ENV) — é o processo
// real da API (`npm run dev`) que já ocupa a porta 3000 durante o desenvolvimento (ver regra
// do projeto em CLAUDE.md). Para bater HTTP real no app sem colidir com esse processo
// (EADDRINUSE) nem precisar derrubá-lo, fixamos PORT para uma porta alternativa ANTES do
// `require('../app')` — o require então sobe sua própria instância real nessa porta.
process.env.PORT = process.env.CONSTRUCTION_HTTP_TEST_PORT || '34591';

const app = require('../app');
const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const {
  Project,
  ProjectStage,
  StageMeasurement,
  MaintenanceCase,
  Property,
  Budget,
  BudgetLine,
} = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const marginRulesService = require('../src/features/construction/marginRules.service');

let tenant;
let baseUrl;
let token;
// GAP 1 (fechamento de auditoria externa Nayara, Marco 6): token de um ator SEM
// "construction:approve" — usado para provar que a rota realmente bloqueia com 403, e não só
// "existe a chamada requirePermission" lida no código-fonte sem nenhum teste HTTP end-to-end.
let tokenWithoutApprove;

// IDs criados por este arquivo, para limpeza garantida no `after()`.
const createdProjectIds = [];
const createdStageIds = [];
const createdMeasurementIds = [];
const createdMaintenanceCaseIds = [];
const createdPropertyIds = [];
const createdBudgetIds = [];
const createdBudgetLineIds = [];

before(async () => {
  tenant = await getSeedTenant();

  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['construction:create', 'construction:read', 'construction:update', 'construction:approve'],
  });

  tokenWithoutApprove = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['field'],
    permissions: ['construction:create', 'construction:read'],
  });

  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  // Dá um instante para o `app.listen` (disparado no `require('../app')` acima) terminar de
  // abrir o socket antes do primeiro fetch.
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  // Limpeza — ordem inversa de dependência (measurement -> stage -> project; maintenance case -> property).
  if (createdMeasurementIds.length > 0) {
    await StageMeasurement.destroy({ where: { id: createdMeasurementIds }, force: true });
  }
  if (createdMaintenanceCaseIds.length > 0) {
    await MaintenanceCase.destroy({ where: { id: createdMaintenanceCaseIds }, force: true });
  }
  if (createdBudgetLineIds.length > 0) {
    await BudgetLine.destroy({ where: { id: createdBudgetLineIds }, force: true });
  }
  if (createdBudgetIds.length > 0) {
    await Budget.destroy({ where: { id: createdBudgetIds }, force: true });
  }
  if (createdStageIds.length > 0) {
    await ProjectStage.destroy({ where: { id: createdStageIds }, force: true });
  }
  if (createdProjectIds.length > 0) {
    await Project.destroy({ where: { id: createdProjectIds }, force: true });
  }
  if (createdPropertyIds.length > 0) {
    await Property.destroy({ where: { id: createdPropertyIds }, force: true });
  }

  await sequelize.close();
  // Sem referência ao server HTTP real criado dentro de `app.js` (não exportado) — o
  // encerramento do processo do test runner (um processo por arquivo) libera a porta.
  process.exit(0);
});

function authFetch(method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function authFetchAs(bearerToken, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createTestProjectAndStage() {
  // Criados direto via service (commitado de verdade, sem rollback) — mesma fábrica de dados
  // de negócio usada pelo endpoint HTTP real, só sem passar pela camada HTTP (o que este
  // arquivo já testa à parte nos próprios casos de teste).
  const project = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return projectsService.createProject(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `HOMO QA HTTP Obra ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
  });
  createdProjectIds.push(project.id);

  const stage = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return projectStagesService.createProjectStage(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, name: 'Etapa HTTP QA' },
      tenant.userId,
      transaction
    );
  });
  createdStageIds.push(stage.id);

  return { project, stage };
}

// --- POST /construction/projects/:id/measurements (path canônico exigido pela fonte) ---

test('HTTP real: POST /construction/projects/:id/measurements cria a medição (201)', async () => {
  const { project, stage } = await createTestProjectAndStage();

  const response = await authFetch('POST', `/construction/projects/${project.id}/measurements`, {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    projectStageId: stage.id,
    measuredPct: 25,
    measuredAt: '2026-10-01',
    totalAmount: 1000,
  });

  assert.equal(response.status, 201, `esperava 201, recebeu ${response.status}`);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.projectStageId, stage.id);
  assert.equal(body.data.status, 'DRAFT');
  createdMeasurementIds.push(body.data.id);
});

// --- POST /construction/measurements/:id/approve (path canônico exigido pela fonte) ---

test('HTTP real: POST /construction/measurements/:id/approve aprova a medição já revisada (200)', async () => {
  const { stage } = await createTestProjectAndStage();

  // Chega a medição até REVIEWED via service direto (comitado), simulando o fluxo real até o
  // ponto que só falta a aprovação final — é exatamente esse último passo que este teste
  // precisa exercitar via HTTP real no path /measurements/:id/approve.
  const measurement = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    const created = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 50, measuredAt: '2026-10-01', totalAmount: 500 },
      tenant.userId,
      transaction
    );
    await stageMeasurementsService.submitStageMeasurement(created.id, tenant.userId, transaction);
    await stageMeasurementsService.reviewStageMeasurement(created.id, {}, tenant.userId, transaction);
    return created;
  });
  createdMeasurementIds.push(measurement.id);

  const response = await authFetch('POST', `/construction/measurements/${measurement.id}/approve`, {});

  assert.equal(response.status, 200, `esperava 200, recebeu ${response.status}`);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.id, measurement.id);
  assert.equal(body.data.status, 'PAYABLE', 'medição aprovada deve avançar até PAYABLE (obrigação financeira criada)');
});

// GAP 1 (auditoria externa Nayara, fechamento Marco 6): a trava de permissão em
// `/construction/measurements/:id/approve` (construction.routes.js, requirePermission
// 'construction:approve') nunca tinha um teste HTTP real dedicado — só era "lida" no código-
// fonte. Este teste prova, com uma requisição HTTP de verdade (mesmo app real, mesmo JWT real),
// que um ator autenticado SEM "construction:approve" recebe 403 e NÃO consegue aprovar a
// medição, mesmo ela já estando REVIEWED (única coisa faltando pra aprovação final).
test('HTTP real: POST /construction/measurements/:id/approve SEM permissão construction:approve é bloqueado (403)', async () => {
  const { stage } = await createTestProjectAndStage();

  const measurement = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    const created = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 60, measuredAt: '2026-10-01', totalAmount: 600 },
      tenant.userId,
      transaction
    );
    await stageMeasurementsService.submitStageMeasurement(created.id, tenant.userId, transaction);
    await stageMeasurementsService.reviewStageMeasurement(created.id, {}, tenant.userId, transaction);
    return created;
  });
  createdMeasurementIds.push(measurement.id);

  const response = await authFetchAs(tokenWithoutApprove, 'POST', `/construction/measurements/${measurement.id}/approve`, {});

  assert.equal(response.status, 403, `esperava 403, recebeu ${response.status}`);
  const body = await response.json();
  assert.equal(body.success, false);

  // Confirma que o bloqueio é real — a medição continua REVIEWED, nunca avançou pra PAYABLE.
  const stillReviewed = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return StageMeasurement.findByPk(measurement.id, { transaction });
  });
  assert.equal(stillReviewed.status, 'REVIEWED');
});

// --- POST /construction/warranty-cases (path canônico exigido pela fonte) ---

test('HTTP real: POST /construction/warranty-cases cria o caso de garantia/pós-obra (201)', async () => {
  const property = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return Property.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel HTTP QA ${uniqueSuffix()}`,
        internalCode: `HTTPQA-${uniqueSuffix()}`,
        propertyType: 'HOUSE',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
  });
  createdPropertyIds.push(property.id);

  const response = await authFetch('POST', '/construction/warranty-cases', {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    propertyId: property.id,
    description: 'Infiltração no teto da sala — HTTP QA',
    severity: 'HIGH',
  });

  assert.equal(response.status, 201, `esperava 201, recebeu ${response.status}`);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.propertyId, property.id);
  assert.equal(body.data.status, 'OPEN');
  createdMaintenanceCaseIds.push(body.data.id);
});

// --- TAREFA 1 (auditoria Marco 6, fechamento de gap): imutabilidade de baseline aprovada,
// exercitada via HTTP real (PATCH /construction/budget-lines/:id), não só via chamada direta
// ao service. Cria obra + orçamento + linha + aprova (baseline congela) tudo comitado de
// verdade, bate PATCH HTTP real tentando mudar `plannedAmount` e confirma 400/422 com o código
// BUDGET_LINE_BASELINE_LOCKED que o service já lança, E que o valor no banco não mudou.
test('HTTP real: PATCH /construction/budget-lines/:id com baseline APPROVED é bloqueado (400/422 BUDGET_LINE_BASELINE_LOCKED)', async () => {
  const { project } = await createTestProjectAndStage();

  const { budget, line } = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });

    await marginRulesService.createMarginRule(
      { groupId: tenant.groupId, companyId: tenant.companyId, minMarginPct: 10 },
      tenant.userId,
      transaction
    );
    const createdBudget = await budgetsService.createBudget(project.id, { groupId: tenant.groupId, companyId: tenant.companyId }, tenant.userId, transaction);
    const createdLine = await budgetLinesService.createBudgetLine(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, category: 'FUNDACAO', plannedAmount: 5000, budgetId: createdBudget.id },
      tenant.userId,
      transaction
    );
    const approvedBudget = await budgetsService.approveBudget(createdBudget.id, tenant.userId, transaction);
    return { budget: approvedBudget, line: createdLine };
  });
  createdBudgetIds.push(budget.id);
  createdBudgetLineIds.push(line.id);

  const response = await authFetch('PATCH', `/construction/budget-lines/${line.id}`, {
    plannedAmount: 9999,
  });

  // O service lança AppError.conflict (409) pra BUDGET_LINE_BASELINE_LOCKED — o teste valida
  // o CÓDIGO estável de erro (contrato real do client), aceitando qualquer status de erro de
  // cliente (400/409/422) que o service já usa pra essa família de bloqueio de baseline.
  assert.ok(
    [400, 409, 422].includes(response.status),
    `esperava 400, 409 ou 422, recebeu ${response.status}`
  );
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error?.code || body.code, 'BUDGET_LINE_BASELINE_LOCKED');

  const persisted = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return BudgetLine.findByPk(line.id, { transaction });
  });
  assert.equal(Number(persisted.plannedAmount), 5000, 'plannedAmount no banco não pode ter mudado');
});
