'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, Project } = require('../../models');
const { publishProjectDelayDetected } = require('../../features/construction/constructionEvents.service');

/**
 * projectDelayDetectionJob (M6-74, corrigido em 30/09/2026 — auditoria pós-merge encontrou a
 * ausência total) — varre obras com `endsAtPlanned` no passado que ainda não chegaram a um
 * status terminal (DELIVERED/CANCELLED) e publica `project.delay.detected`. Mesmo padrão de
 * `warrantyEscalationJob.js` (varredura por grupo/empresa com SET LOCAL, uma transação por
 * empresa).
 *
 * Idempotência: a `idempotencyKey` do evento inclui a data corrente (YYYY-MM-DD) — o outbox
 * deduplica reprocessamentos no MESMO dia (rodar o job várias vezes seguidas não duplica o
 * evento), mas o dia seguinte gera um novo evento de lembrete enquanto a obra continuar
 * atrasada — comportamento desejado para escalonamento, não um bug de duplicação.
 */

const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'];

function todayKey(now) {
  return now.toISOString().slice(0, 10);
}

async function detectDelayedProjects(transaction, now = new Date()) {
  const candidates = await Project.findAll({
    where: {
      endsAtPlanned: { [Op.ne]: null, [Op.lt]: now },
      status: { [Op.notIn]: TERMINAL_STATUSES },
    },
    transaction,
  });

  let detected = 0;
  for (const project of candidates) {
    await publishProjectDelayDetected(project, todayKey(now), transaction);
    detected += 1;
  }

  return { projectsChecked: candidates.length, detected };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return detectDelayedProjects(transaction);
  });
}

async function runProjectDelayDetectionJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, projectsChecked: 0, detected: 0, errors: 0 };

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
        summary.detected += result.detected;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[ProjectDelayDetectionJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ProjectDelayDetectionJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.projectsChecked} obra(s) verificada(s), ${summary.detected} evento(s) publicado(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

function startProjectDelayDetectionJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runProjectDelayDetectionJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[ProjectDelayDetectionJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runProjectDelayDetectionJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[ProjectDelayDetectionJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runProjectDelayDetectionJob,
  startProjectDelayDetectionJob,
  detectDelayedProjects,
  processProjectDelayDetectionForCompany: processCompany,
};
