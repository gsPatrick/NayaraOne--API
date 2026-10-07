'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, Project, DailyReport, Task } = require('../../models');

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

function toDateOnlyString(date) {
  return date.toISOString().slice(0, 10);
}

function previousBusinessDay(now) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - 1);
  // Sábado (6) e domingo (0) não são dia útil — volta para a sexta-feira anterior.
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date;
}

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

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return detectMissingDailyReports(transaction);
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
  processMissingDailyReportJobForCompany: processCompany,
  previousBusinessDay,
};
