'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, FeedbackCase } = require('../../models');
const { escalateFeedbackCase, ESCALATABLE_STATUSES } = require('../../features/crm/feedbackCases.service');

/**
 * feedbackCaseAlertJob (M3-20) — escalona AUTOMATICAMENTE os casos de reclamação/elogio/
 * conflito cujo `sla_due_at` já passou e que ainda estão OPEN/IN_PROGRESS, notificando o
 * responsável. Mesmo padrão (e mesma estrutura de varredura por grupo/empresa com SET LOCAL)
 * de legalDeadlineAlertJob.js.
 *
 * O escalonamento em si NÃO é reimplementado aqui: o job chama a MESMA
 * `escalateFeedbackCase` usada pela rota manual (com `automatic: true`), então o caso
 * escalonado pelo job fica exatamente igual — status, escalated_at, Notification, domain
 * event e auditoria — a um escalonado na mão. Isso evita que job e API divirjam com o tempo.
 *
 * Idempotência: só pega casos com status em OPEN/IN_PROGRESS. Depois do primeiro
 * escalonamento o status vira ESCALATED e o caso sai do filtro — a próxima rodada do job não
 * reescalona nem renotifica o mesmo caso.
 */

/**
 * escalateOverdueFeedbackCases — o miolo do job, isolado numa função que recebe a transação
 * de fora. Serve para dois propósitos: (1) `processCompany` a usa dentro da sua própria
 * transação por empresa; (2) os testes conseguem exercitar o comportamento REAL do job dentro
 * de `withRollbackTenantTransaction`, sem persistir nada no banco compartilhado.
 */
async function escalateOverdueFeedbackCases(transaction, now = new Date()) {
  const overdue = await FeedbackCase.findAll({
    where: {
      status: { [Op.in]: ESCALATABLE_STATUSES },
      slaDueAt: { [Op.lt]: now },
    },
    transaction,
  });

  let escalated = 0;
  for (const feedbackCase of overdue) {
    // actorUserId null = ação automática do sistema (ver registrarAuditoria).
    await escalateFeedbackCase(feedbackCase.id, { automatic: true }, null, transaction);
    escalated += 1;
  }

  return { casesChecked: overdue.length, escalated };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return escalateOverdueFeedbackCases(transaction);
  });
}

async function runFeedbackCaseAlertJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, casesChecked: 0, escalated: 0, errors: 0 };

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
        summary.casesChecked += result.casesChecked;
        summary.escalated += result.escalated;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[FeedbackCaseAlertJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[FeedbackCaseAlertJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.casesChecked} caso(s) com SLA vencido, ${summary.escalated} escalonado(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function startFeedbackCaseAlertJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runFeedbackCaseAlertJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[FeedbackCaseAlertJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runFeedbackCaseAlertJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[FeedbackCaseAlertJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runFeedbackCaseAlertJob,
  startFeedbackCaseAlertJob,
  escalateOverdueFeedbackCases,
  processFeedbackCaseAlertsForCompany: processCompany,
};
