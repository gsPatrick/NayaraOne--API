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

/**
 * M5-27 — ESCALONAMENTO REAL. Até aqui o job só notificava o `responsibleUserId` do caso e,
 * pela regra de "só alerta quando a severidade piora", um prazo que ficasse OVERDUE e fosse
 * ignorado nunca mais gerava aviso nenhum — o prazo simplesmente morria na caixa de um único
 * usuário. Agora: se um prazo continua OVERDUE por mais de ESCALATION_WINDOW_MS depois do
 * PRIMEIRO alerta de OVERDUE (legal_deadlines.first_overdue_alerted_at) e ninguém resolveu,
 * o job notifica também o `escalationUserId` do caso (legal.legal_cases.escalation_user_id) e
 * marca `escalated_at` — que serve de guarda de idempotência: escalona uma vez, não a cada
 * rodada de 30 minutos.
 */
const ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * processEscalations — segunda passada do job, independente da regra de "severidade piorou":
 * varre os prazos ainda PENDING que já foram alertados como OVERDUE, e escalona os que
 * estouraram a janela sem terem sido escalados ainda.
 */
async function processEscalations(transaction, now) {
  const candidates = await LegalDeadline.findAll({
    where: { status: 'PENDING', lastAlertedSeverity: 'OVERDUE', escalatedAt: null },
    transaction,
  });
  let escalated = 0;

  for (const deadline of candidates) {
    if (!deadline.firstOverdueAlertedAt) continue;
    const elapsed = now.getTime() - new Date(deadline.firstOverdueAlertedAt).getTime();
    if (elapsed <= ESCALATION_WINDOW_MS) continue;

    const legalCase = await LegalCase.findByPk(deadline.legalCaseId, { transaction });
    if (!legalCase || !legalCase.escalationUserId) {
      // Sem alvo de escalonamento configurado não há para quem escalar. NÃO marcamos
      // escalated_at nesse caso: se a cliente configurar o escalationUserId depois, o prazo
      // ainda vencido volta a ser candidato na próxima rodada em vez de ficar silenciado.
      continue;
    }

    await Notification.create(
      {
        groupId: deadline.groupId,
        companyId: deadline.companyId,
        userId: legalCase.escalationUserId,
        channel: 'IN_APP',
        title: 'ESCALONAMENTO — prazo jurídico vencido sem tratativa',
        body:
          `"${deadline.description}" (processo ${legalCase.caseNumber || legalCase.id}) está VENCIDO desde ` +
          `${new Date(deadline.dueAt).toLocaleString('pt-BR')} e continua sem ação mais de 24h após o primeiro alerta ao responsável.`,
        createdBy: null,
        updatedBy: null,
      },
      { transaction }
    );

    deadline.escalatedAt = now;
    await deadline.save({ transaction });

    await registrarAuditoria(
      {
        groupId: deadline.groupId,
        companyId: deadline.companyId,
        actorUserId: null,
        action: 'legal.deadline.job_escalation',
        entityType: 'LegalDeadline',
        entityId: deadline.id,
        afterJson: { escalatedAt: deadline.escalatedAt, escalationUserId: legalCase.escalationUserId },
        reason: `Prazo "${deadline.description}" vencido há mais de 24h sem ação: escalado para o usuário ${legalCase.escalationUserId}.`,
      },
      transaction
    );

    escalated += 1;
  }

  return escalated;
}

/**
 * processDeadlinesInTransaction — corpo real do job para UMA empresa, recebendo a transação
 * já com o contexto de tenant setado (SET LOCAL app.group_id/app.company_id). Extraído de
 * processCompany para que os testes possam exercitar o job DENTRO da própria transação de
 * rollback (withRollbackTenantTransaction), sem deixar dados no banco compartilhado e sem
 * bypass nenhum de RLS — é exatamente o mesmo código que roda em produção.
 */
async function processDeadlinesInTransaction(transaction, nowOverride) {
    const deadlines = await LegalDeadline.findAll({ where: { status: 'PENDING' }, transaction });
    const now = nowOverride || new Date();
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
      // Marca o instante do PRIMEIRO alerta de OVERDUE (nunca sobrescrito) — é a partir dele
      // que a janela de escalonamento de 24h é contada.
      if (severity === 'OVERDUE' && !deadline.firstOverdueAlertedAt) {
        deadline.firstOverdueAlertedAt = now;
      }
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

    const escalated = await processEscalations(transaction, now);

    return { deadlinesChecked: deadlines.length, alerted, escalated };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return processDeadlinesInTransaction(transaction);
  });
}

async function runLegalDeadlineAlertJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, deadlinesChecked: 0, alerted: 0, escalated: 0, errors: 0 };

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
        summary.escalated += result.escalated;
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
      `${summary.deadlinesChecked} prazo(s) verificado(s), ${summary.alerted} alerta(s) novo(s), ` +
      `${summary.escalated} escalonamento(s), ${summary.errors} erro(s).`
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

module.exports = {
  runLegalDeadlineAlertJob,
  startLegalDeadlineAlertJob,
  processLegalDeadlineAlertsForCompany: processCompany,
  processDeadlinesInTransaction,
  ESCALATION_WINDOW_MS,
};
