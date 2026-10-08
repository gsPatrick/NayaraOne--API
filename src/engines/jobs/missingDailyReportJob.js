'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, Project, DailyReport, DailyWorker, Task } = require('../../models');
const { toDateOnlyString, previousBusinessDay } = require('./businessDays.helper');

/**
 * missingDailyReportJob — achado numa rodada de verificação de integrações (30/09/2026): a
 * fonte é explícita — "Fotos possuem hash/origem; ausência de diário gera tarefa conforme
 * regra." (seção "6. Diário" da fonte) — nenhum job existia para detectar a AUSÊNCIA de RDO,
 * só a criação/correção de um RDO existente (dailyReports.service.js).
 *
 * Regra: toda obra em ACTIVE que não tem NENHUM RDO (`construction.daily_reports`) para o dia
 * útil anterior (`checkDate`, default = ontem) recebe uma tarefa em `core.tasks`
 * (`related_entity_type = 'construction.projects'`) atribuída ao responsável do projeto, se
 * houver. Mesmo padrão de tarefa polimórfica já usado em `opportunityTasks.service.js`.
 *
 * Idempotência: antes de criar, verifica se já existe uma Task aberta com o mesmo
 * `relatedEntityId` + título contendo a data verificada — rodar o job várias vezes no mesmo dia
 * não duplica a tarefa.
 */

const ACTIVE_STATUS = 'ACTIVE';

// GAP 1 (auditoria externa Nayara, Marco 6/NAY Obras): `toDateOnlyString`/`previousBusinessDay`
// foram extraídos para `businessDays.helper.js` porque `nayObras.service.js#summarizeProject`
// precisa da MESMA definição de "dia útil" para contar dias sem RDO no resumo da NAY — nunca
// duas implementações divergentes da mesma regra.

async function detectMissingDailyReports(transaction, now = new Date()) {
  const checkDate = toDateOnlyString(previousBusinessDay(now));

  const activeProjects = await Project.findAll({ where: { status: ACTIVE_STATUS }, transaction });

  let tasksCreated = 0;
  for (const project of activeProjects) {
    const hasReport = await DailyReport.findOne({
      where: { projectId: project.id, reportDate: checkDate },
      transaction,
    });
    if (hasReport) continue;

    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 44, 2026-10-05): o dedupe era
    // "check-then-create" puro, sem nenhum lock — em deploy multi-réplica, dois processos
    // podiam ambos checar "não existe Task ainda" antes de qualquer INSERT comitar e criar
    // duas tarefas duplicadas pro mesmo projeto/dia. `pg_advisory_xact_lock` (mesmo mecanismo
    // já usado em marginRules.service.js) serializa esse check-then-create por projeto+dia —
    // o lock é liberado automaticamente no commit/rollback da transação.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `missing-daily-report:${project.id}:${checkDate}` },
      transaction,
    });

    const taskTitle = `RDO ausente em ${project.name} (${checkDate})`;
    const existingTask = await Task.findOne({
      where: {
        relatedEntityType: 'construction.projects',
        relatedEntityId: project.id,
        title: taskTitle,
        status: { [Op.ne]: 'CANCELED' },
      },
      transaction,
    });
    if (existingTask) continue;

    await Task.create(
      {
        groupId: project.groupId,
        companyId: project.companyId,
        assignedToUserId: project.responsibleUserId || null,
        title: taskTitle,
        description: `Nenhum RDO foi registrado para a obra "${project.name}" em ${checkDate}. Verifique com a equipe de campo e registre o diário pendente.`,
        relatedEntityType: 'construction.projects',
        relatedEntityId: project.id,
        status: 'OPEN',
        priority: 'HIGH',
      },
      { transaction }
    );
    tasksCreated += 1;
  }

  return { projectsChecked: activeProjects.length, checkDate, tasksCreated };
}

// GAP REAL CORRIGIDO (auditoria externa Nayara, 2026-10-08): o job só cobria a ausência do
// DIÁRIO em si — a fonte também exige rastrear a ausência de DOCUMENTOS do trabalhador
// (DailyWorker.documentFileIds, ver M6 "documentação correspondente ao prestador"). Reaproveita
// a MESMA infraestrutura (janela de dias úteis, lock advisory por projeto+chave, dedupe por
// Task aberta) em vez de duplicar o mecanismo — só muda O QUE é verificado e o
// `relatedEntityType` da Task gerada, para não se confundir com a tarefa de "RDO ausente".
const MISSING_WORKER_DOCUMENTS_WINDOW_DAYS = 7;
const MISSING_WORKER_DOCUMENTS_ENTITY_TYPE = 'construction.daily_workers';

async function detectMissingWorkerDocuments(transaction, now = new Date()) {
  const windowEnd = toDateOnlyString(previousBusinessDay(now));
  const windowStartDate = new Date(`${windowEnd}T00:00:00.000Z`);
  windowStartDate.setUTCDate(windowStartDate.getUTCDate() - MISSING_WORKER_DOCUMENTS_WINDOW_DAYS);
  const windowStart = toDateOnlyString(windowStartDate);

  const activeProjects = await Project.findAll({ where: { status: ACTIVE_STATUS }, transaction });

  let tasksCreated = 0;
  for (const project of activeProjects) {
    const reportsInWindow = await DailyReport.findAll({
      where: { projectId: project.id, reportDate: { [Op.between]: [windowStart, windowEnd] } },
      transaction,
    });
    if (!reportsInWindow.length) continue;

    const workersMissingDocs = await DailyWorker.findAll({
      where: {
        dailyReportId: { [Op.in]: reportsInWindow.map((r) => r.id) },
        [Op.or]: [{ documentFileIds: [] }, { documentFileIds: null }],
      },
      transaction,
    });
    if (!workersMissingDocs.length) continue;

    // Mesmo lock advisory já usado para "RDO ausente" (serializa check-then-create por
    // projeto+janela), com chave própria para não colidir com o lock da outra verificação.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `missing-worker-documents:${project.id}:${windowEnd}` },
      transaction,
    });

    const taskTitle = `Documentação de trabalhador(es) pendente em ${project.name} (até ${windowEnd})`;
    const existingTask = await Task.findOne({
      where: {
        relatedEntityType: MISSING_WORKER_DOCUMENTS_ENTITY_TYPE,
        relatedEntityId: project.id,
        title: taskTitle,
        status: { [Op.ne]: 'CANCELED' },
      },
      transaction,
    });
    if (existingTask) continue;

    await Task.create(
      {
        groupId: project.groupId,
        companyId: project.companyId,
        assignedToUserId: project.responsibleUserId || null,
        title: taskTitle,
        description:
          `${workersMissingDocs.length} trabalhador(es) sem documentação ("documentFileIds") registrada nos RDOs ` +
          `da obra "${project.name}" entre ${windowStart} e ${windowEnd}. Verifique e anexe a documentação pendente.`,
        relatedEntityType: MISSING_WORKER_DOCUMENTS_ENTITY_TYPE,
        relatedEntityId: project.id,
        status: 'OPEN',
        priority: 'MEDIUM',
      },
      { transaction }
    );
    tasksCreated += 1;
  }

  return { projectsChecked: activeProjects.length, windowStart, windowEnd, tasksCreated };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    const missingReports = await detectMissingDailyReports(transaction);
    const missingDocuments = await detectMissingWorkerDocuments(transaction);
    return {
      projectsChecked: missingReports.projectsChecked,
      tasksCreated: missingReports.tasksCreated + missingDocuments.tasksCreated,
    };
  });
}

async function runMissingDailyReportJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, projectsChecked: 0, tasksCreated: 0, errors: 0 };

  for (const group of groups) {
    summary.groupsChecked += 1;
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (const company of companies) {
      summary.companiesChecked += 1;
      try {
        const result = await processCompany(group, company);
        summary.projectsChecked += result.projectsChecked;
        summary.tasksCreated += result.tasksCreated;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[MissingDailyReportJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[MissingDailyReportJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.projectsChecked} obra(s) verificada(s), ${summary.tasksCreated} tarefa(s) criada(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 dia

function startMissingDailyReportJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runMissingDailyReportJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[MissingDailyReportJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runMissingDailyReportJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[MissingDailyReportJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runMissingDailyReportJob,
  startMissingDailyReportJob,
  detectMissingDailyReports,
  detectMissingWorkerDocuments,
  processMissingDailyReportJobForCompany: processCompany,
  previousBusinessDay,
};
