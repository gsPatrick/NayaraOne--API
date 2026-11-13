'use strict';

const { sequelize, Group, Company } = require('../../models');
const { escalateOverdueCrmTasks } = require('../../features/crm/taskOverdueEscalation');

/**
 * crmTaskOverdueJob — varredura periódica, por grupo/empresa com SET LOCAL, da regra do livro do Marco 3 §11 "Tarefa vencida
 * escala conforme regra" (evento mínimo crm.task.overdue, §17). A regra em si (dois níveis: responsável e, depois do prazo
 * configurável, a gerência; só tarefa de oportunidade em aberto; marca por tarefa e vencimento) está em
 * src/features/crm/taskOverdueEscalation.js, exercitada pelos testes dentro de withRollbackTenantTransaction.
 */

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return escalateOverdueCrmTasks(transaction);
  });
}

async function runCrmTaskOverdueJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, tasksChecked: 0, escalated: 0, escalatedToManagement: 0, errors: 0 };

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
        summary.tasksChecked += result.tasksChecked;
        summary.escalated += result.escalated;
        summary.escalatedToManagement += result.escalatedToManagement;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[CrmTaskOverdueJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[CrmTaskOverdueJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.tasksChecked} tarefa(s) vencida(s), ${summary.escalated} escalonada(s), ${summary.escalatedToManagement} para a gerência, ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function startCrmTaskOverdueJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runCrmTaskOverdueJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[CrmTaskOverdueJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runCrmTaskOverdueJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[CrmTaskOverdueJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runCrmTaskOverdueJob,
  startCrmTaskOverdueJob,
  escalateOverdueCrmTasks,
  processCrmTaskOverdueForCompany: processCompany,
};
