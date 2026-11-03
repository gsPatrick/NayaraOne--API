'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, InsuranceRenewalTask, InsurancePolicy, Notification } = require('../../models');

/**
 * insuranceRenewalAlertJob (Marco 7 — Insurance Hub, contrato Anexo I: "renovação alerta").
 *
 * Gap real encontrado em auditoria "loop até secar" (rodada 7, 2026-10-05): `issuePolicy`
 * sempre criou a `InsuranceRenewalTask` na emissão, mas nada no sistema jamais lia essa tarefa
 * depois — zero job, zero endpoint, zero UI. A palavra "alerta" no contrato implica que algo
 * precisa de fato notificar alguém, não só persistir uma linha. Este job fecha esse gap
 * seguindo o mesmo padrão já estabelecido por `toolLoanOverdueJob.js`/`legalDeadlineAlertJob.js`:
 * varre tarefas `PENDING` com `dueDate` vencido e cria uma `Notification` IN_APP real.
 *
 * Idempotência: `last_alerted_at` (mesmo papel de `legal_deadlines.first_overdue_alerted_at`)
 * garante que cada tarefa gera UMA notificação, nunca uma por ciclo do job.
 */
async function alertDueRenewals(transaction, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const candidates = await InsuranceRenewalTask.findAll({
    where: { status: 'PENDING', dueDate: { [Op.lte]: today }, lastAlertedAt: null },
    include: [{ model: InsurancePolicy, as: 'policy' }],
    transaction,
  });

  let alerted = 0;
  for (const task of candidates) {
    try {
      await sequelize.transaction({ transaction }, async (nested) => {
        // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 44, 2026-10-05): a varredura
        // inicial não trava as linhas — em deploy multi-réplica, dois processos podiam
        // selecionar a mesma tarefa antes de qualquer UPDATE comitar e ambos criarem
        // Notification duplicada. Re-busca com lock e reconfirma lastAlertedAt === null DENTRO
        // da transação aninhada.
        const locked = await InsuranceRenewalTask.findByPk(task.id, { transaction: nested, lock: nested.LOCK.UPDATE });
        if (!locked || locked.lastAlertedAt !== null) return;

        const policy = task.policy;
        const targetUserId = locked.assignedToUserId || policy?.createdBy;
        if (targetUserId) {
          // GAP REAL CORRIGIDO (auditoria contrato "Alertas: criticidade, responsável, canal e
          // prazo de resposta", 2026-10-08): o corpo citava a apólice/data mas não dizia quantos
          // dias faltam nem qual o prazo de resposta — a tarefa só é alertada quando dueDate já
          // chegou (30 dias antes do vencimento), então `daysUntilExpiry` comunica a urgência
          // real (pode já estar negativo se o job atrasar, nesse caso já está vencida).
          const daysUntilExpiry = policy?.expiryDate
            ? Math.round((new Date(policy.expiryDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
            : null;
          const severity = daysUntilExpiry != null && daysUntilExpiry <= 0 ? 'CRÍTICO' : 'ATENÇÃO';
          const prazo =
            daysUntilExpiry == null
              ? 'inicie a renovação assim que possível'
              : daysUntilExpiry <= 0
              ? `vigência já vencida — regularize hoje`
              : `prazo de resposta: inicie a renovação em até ${daysUntilExpiry} dia(s)`;
          await Notification.create(
            {
              groupId: locked.groupId,
              companyId: locked.companyId,
              userId: targetUserId,
              channel: 'IN_APP',
              title: 'Apólice de seguro vencendo',
              body: `[${severity}] A apólice ${policy?.externalPolicyNumber || policy?.id} vence em ${policy?.expiryDate || 'breve'} — ${prazo}.`,
            },
            { transaction: nested }
          );
        }
        locked.lastAlertedAt = now;
        await locked.save({ transaction: nested });
      });
      alerted += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[InsuranceRenewalAlertJob] Falha ao alertar tarefa ${task.id}: ${err.message}`);
    }
  }

  return { tasksChecked: candidates.length, alerted };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return alertDueRenewals(transaction);
  });
}

async function runInsuranceRenewalAlertJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, tasksChecked: 0, alerted: 0, errors: 0 };

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
        summary.alerted += result.alerted;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[InsuranceRenewalAlertJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[InsuranceRenewalAlertJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.tasksChecked} tarefa(s) verificada(s), ${summary.alerted} alertada(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hora — renovação é prazo de dias, não precisa do intervalo de 30min dos outros jobs

function startInsuranceRenewalAlertJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runInsuranceRenewalAlertJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[InsuranceRenewalAlertJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runInsuranceRenewalAlertJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[InsuranceRenewalAlertJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runInsuranceRenewalAlertJob,
  startInsuranceRenewalAlertJob,
  alertDueRenewals,
  processInsuranceRenewalAlertForCompany: processCompany,
};
