'use strict';

require('dotenv').config();

/**
 * ensureQaRestoreVerifyFixture.js
 *
 * GAP REAL CORRIGIDO (auditoria externa Nayara, 08/10/2026 — complemento ao gap de
 * verifyRestoreConstructionData.js): o banco de dev real não tinha NENHUMA obra com orçamento
 * nem medição preenchidos (construction.budgets e construction.stage_measurements com 0 linhas
 * no momento da auditoria), então nenhuma comparação de restore conseguia de fato exercitar
 * esses dados. Este script cria, pelo SERVICE REAL (mesmos módulos usados pela API — nenhum
 * insert "fake" direto no banco, exceto group/company que seguem o padrão do seed-dev.js), uma
 * obra de teste identificável ("QA Restore Verify - Obra com Medições") com:
 *   - 1 Project (PLANNED)
 *   - 1 Budget (DRAFT) + 1 BudgetLine
 *   - 1 ProjectStage
 *   - 2 StageMeasurement (DRAFT), com measuredPct/totalAmount/status/projectStageId distintos
 *
 * Idempotente: se a obra "QA Restore Verify - Obra com Medições" já existir (mesmo nome, mesmo
 * group/company), não duplica — apenas garante que ela tem orçamento e >=2 medições, criando o
 * que faltar.
 *
 * Uso: node scripts/ensureQaRestoreVerifyFixture.js
 * NUNCA rodar contra produção real de cliente — aqui é usado contra o banco de DEV real
 * (mesmo banco citado no restore/backup), dado que não havia dado de obra nenhum lá para
 * servir de evidência de restore.
 */

const { sequelize, Group, Company, Project, Budget, BudgetLine, ProjectStage, StageMeasurement } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');

const FIXTURE_PROJECT_NAME = 'QA Restore Verify - Obra com Medições';
const FIXTURE_GROUP_NAME = 'Nayara One — Grupo Dev';
const FIXTURE_COMPANY_NAME = 'Nayara One — Empresa Dev';

async function run() {
  await sequelize.authenticate();

  const result = await sequelize.transaction(async (transaction) => {
    // "core"."groups" não tem RLS; "core"."companies" tem (policy keyed em group_id) — mesmo
    // padrão de scripts/seed-dev.js: abre a transação e seta app.group_id ela mesma antes de
    // tocar em companies.
    const [group] = await Group.findOrCreate({
      where: { name: FIXTURE_GROUP_NAME },
      defaults: { name: FIXTURE_GROUP_NAME, legalName: 'Nayara One Desenvolvimento Ltda (fictício)', status: 'ACTIVE' },
      transaction,
    });

    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });

    const [company] = await Company.findOrCreate({
      where: { groupId: group.id, name: FIXTURE_COMPANY_NAME },
      defaults: { groupId: group.id, name: FIXTURE_COMPANY_NAME, status: 'ACTIVE' },
      transaction,
    });

    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });

    let project = await Project.findOne({ where: { groupId: group.id, companyId: company.id, name: FIXTURE_PROJECT_NAME }, transaction });
    let createdProject = false;
    if (!project) {
      project = await projectsService.createProject(
        {
          groupId: group.id,
          companyId: company.id,
          name: FIXTURE_PROJECT_NAME,
          budgetAmount: 500000,
        },
        null,
        transaction
      );
      createdProject = true;
    }

    let budget = await Budget.findOne({ where: { projectId: project.id }, transaction });
    let createdBudget = false;
    if (!budget) {
      budget = await budgetsService.createBudget(project.id, { groupId: group.id, companyId: company.id }, null, transaction);
      await budgetLinesService.createBudgetLine(
        project.id,
        {
          groupId: group.id,
          companyId: company.id,
          category: 'MATERIALS',
          description: 'Fixture QA — materiais (linha de orçamento de teste)',
          plannedAmount: 300000,
          budgetId: budget.id,
        },
        null,
        transaction
      );
      createdBudget = true;
    }

    let stage = await ProjectStage.findOne({ where: { projectId: project.id }, transaction });
    let createdStage = false;
    if (!stage) {
      stage = await projectStagesService.createProjectStage(
        project.id,
        {
          groupId: group.id,
          companyId: company.id,
          name: 'Fixture QA — Etapa de fundação',
          sequence: 1,
          plannedPct: 100,
          plannedCost: 300000,
        },
        null,
        transaction
      );
      createdStage = true;
    }

    const existingMeasurements = await StageMeasurement.findAll({ where: { projectStageId: stage.id }, transaction });
    const createdMeasurements = [];
    if (existingMeasurements.length < 2) {
      const toCreate = 2 - existingMeasurements.length;
      const seedData = [
        { measuredPct: 35.5, measuredAt: '2026-09-15', totalAmount: 105000, notes: 'Fixture QA — medição 1 (etapa iniciada)' },
        { measuredPct: 72.25, measuredAt: '2026-10-01', totalAmount: 215000, notes: 'Fixture QA — medição 2 (avanço da etapa)' },
      ].slice(existingMeasurements.length, existingMeasurements.length + toCreate);

      for (const data of seedData) {
        // eslint-disable-next-line no-await-in-loop
        const measurement = await stageMeasurementsService.createStageMeasurement(
          stage.id,
          {
            groupId: group.id,
            companyId: company.id,
            measuredPct: data.measuredPct,
            measuredAt: data.measuredAt,
            totalAmount: data.totalAmount,
            notes: data.notes,
          },
          null,
          transaction
        );
        createdMeasurements.push(measurement);
      }
    }

    const allMeasurements = await StageMeasurement.findAll({ where: { projectStageId: stage.id }, transaction, order: [['measured_at', 'ASC']] });

    return {
      groupId: group.id,
      companyId: company.id,
      projectId: project.id,
      budgetId: budget.id,
      stageId: stage.id,
      createdProject,
      createdBudget,
      createdStage,
      createdMeasurementsCount: createdMeasurements.length,
      measurementIds: allMeasurements.map((m) => m.id),
    };
  });

  // eslint-disable-next-line no-console
  console.log('[ensureQaRestoreVerifyFixture] OK:', JSON.stringify(result, null, 2));
  await sequelize.close();
  return result;
}

if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[ensureQaRestoreVerifyFixture] Falha:', err);
    process.exitCode = 1;
  });
}

module.exports = { run, FIXTURE_PROJECT_NAME };
