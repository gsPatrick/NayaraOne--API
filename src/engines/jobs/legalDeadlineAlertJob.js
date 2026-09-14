'use strict';

const { sequelize, Group, Company, LegalDeadline, LegalCase, Notification } = require('../../models');
const { computeSeverity } = require('../../features/legal/legalDeadlines.service');
const { publishLegalDeadlineAlert } = require('../../features/legal/legalEvents.service');
const { registrarAuditoria } = require('../audit/auditLog.service');

/**
 * legalDeadlineAlertJob — reportado pela cliente 14/09/2026: "processos jurídicos, prazos e
 * alertas efetivamente utilizáveis". A severidade (OVERDUE/DUE_SOON) já era calculada em
 * legalDeadlines.service.js, mas só na hora em que alguém abria a tela — não existia nenhum
 * alerta proativo. Este job roda periodicamente, recalcula a severidade de todo prazo PENDING
 * e, quando ela PIORA em relação à última vez que alertamos (last_alerted_severity), cria uma
 * Notification IN_APP pro responsável do caso + publica um evento de domínio (auditável,
 * consultável em /api/metrics via a fila do Outbox). Mesmo padrão de radarMatchingJob.js.
 */

const SEVERITY_RANK = { NORMAL: 0, DUE_SOON: 1, OVERDUE: 2, DONE: -1 };

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });

    const deadlines = await LegalDeadline.findAll({ where: { status: 'PENDING' }, transaction });
    const now = new Date();
    let alerted = 0;

    for (const deadline of deadlines) {
      const severity = computeSeverity(deadline, now);
      // Só alerta OVERDUE/DUE_SOON, e só quando é PIOR que a última vez que alertamos —
      // evita reavisar a cada rodada do job (a cada 30 min) pelo mesmo prazo parado.
      if (severity !== 'OVERDUE' && severity !== 'DUE_SOON') continue;
      const previousRank = SEVERITY_RANK[deadline.lastAlertedSeverity] ?? -1;
      if (SEVERITY_RANK[severity] <= previousRank) continue;

      const legalCase = await LegalCase.findByPk(deadline.legalCaseId, { transaction });

      await publishLegalDeadlineAlert(deadline, severity, transaction);

      if (legalCase && legalCase.responsibleUserId) {
        await Notification.create(
          {
            groupId: deadline.groupId,
            companyId: deadline.companyId,
            userId: legalCase.responsibleUserId,
            channel: 'IN_APP',
            title: severity === 'OVERDUE' ? 'Prazo jurídico VENCIDO' : 'Prazo jurídico próximo de vencer',
            body: `"${deadline.description}" (processo ${legalCase.caseNumber || legalCase.id}) vence em ${new Date(deadline.dueAt).toLocaleString('pt-BR')}.`,
            createdBy: null,
            updatedBy: null,
          },
          { transaction }
        );
      }

      deadline.lastAlertedSeverity = severity;
      deadline.updatedBy = null;
      await deadline.save({ transaction });

      await registrarAuditoria(
        {
          groupId: deadline.groupId,
          companyId: deadline.companyId,
          actorUserId: null,
          action: 'legal.deadline.job_alert',
          entityType: 'LegalDeadline',
          entityId: deadline.id,
          afterJson: { severity, dueAt: deadline.dueAt },
          reason: `Job automático de prazos jurídicos alertou severidade ${severity} para o prazo "${deadline.description}".`,
        },
        transaction
      );

      alerted += 1;
    }

    return { deadlinesChecked: deadlines.length, alerted };
  });
}

async function runLegalDeadlineAlertJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, deadlinesChecked: 0, alerted: 0, errors: 0 };

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
        summary.deadlinesChecked += result.deadlinesChecked;
        summary.alerted += result.alerted;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[LegalDeadlineAlertJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[LegalDeadlineAlertJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.deadlinesChecked} prazo(s) verificado(s), ${summary.alerted} alerta(s) novo(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function startLegalDeadlineAlertJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runLegalDeadlineAlertJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[LegalDeadlineAlertJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runLegalDeadlineAlertJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[LegalDeadlineAlertJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = { runLegalDeadlineAlertJob, startLegalDeadlineAlertJob, processLegalDeadlineAlertsForCompany: processCompany };
