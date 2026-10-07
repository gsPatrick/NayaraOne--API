'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, InventoryToolLoan, Notification } = require('../../models');
const { publishToolLoanOverdue } = require('../../features/inventory/inventoryEvents.service');

/**
 * toolLoanOverdueJob (Marco 7 — Caderno item 14/EST-TS-13) — varre tool_loans OPEN com
 * due_at vencido e publica `tool.loan.overdue`. Mesmo padrão (por grupo/empresa, SET LOCAL,
 * uma transação por empresa) de warrantyEscalationJob.js/feedbackCaseAlertJob.js.
 *
 * Idempotência: a chave do evento inclui `lockVersion` do loan — só muda de valor quando o
 * loan sofre alguma alteração real, então rodar o job repetidamente sem nada mudar não
 * duplica o evento no outbox (dedupe por idempotencyKey já garantido por publishDomainEvent).
 */
async function escalateOverdueToolLoans(transaction, now = new Date()) {
  // BUG REAL CORRIGIDO: a versão anterior republicava tool.loan.overdue em TODO ciclo do job
  // pra qualquer loan OPEN vencido, sem nenhum marcador de "já avisado" — como o
  // idempotencyKey incluía só lockVersion (que não muda sozinho), a 2ª execução sempre batia
  // em "duplicate key value violates unique constraint" e o job falhava pra aquela empresa a
  // cada 30min, indefinidamente. Fix: transição OPEN -> OVERDUE (status já previsto no schema,
  // nunca usado) é o marcador — só dispara o evento na transição, nunca de novo pro mesmo loan.
  const candidates = await InventoryToolLoan.findAll({
    where: { status: 'OPEN', dueAt: { [Op.ne]: null, [Op.lt]: now } },
    transaction,
  });

  // Resiliência por item: cada loan é sua própria savepoint implícita via transação aninhada
  // do Sequelize — se UM loan falhar (ex.: evento órfão de idempotencyKey colidindo por algum
  // motivo externo), os demais ainda são processados em vez de travar a empresa inteira.
  let escalated = 0;
  let notified = 0;
  for (const loan of candidates) {
    try {
      await sequelize.transaction({ transaction }, async (nested) => {
        // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 44, 2026-10-05): a varredura
        // inicial (findAll acima) não trava as linhas — em deploy com múltiplas réplicas do
        // mesmo processo Node, dois processos podem selecionar o MESMO loan OPEN antes de
        // qualquer UPDATE comitar, e ambos criariam uma Notification duplicada (o outbox é
        // protegido por idempotencyKey, mas a notificação IN_APP não era). Re-busca com lock
        // pessimista e reconfirma o status DENTRO da transação aninhada — se outro processo já
        // escalonou este loan nesse intervalo, o status não será mais OPEN e este processo pula
        // silenciosamente, sem duplicar nada.
        const locked = await InventoryToolLoan.findByPk(loan.id, { transaction: nested, lock: nested.LOCK.UPDATE });
        if (!locked || locked.status !== 'OPEN') return;

        await publishToolLoanOverdue(locked, nested);
        locked.status = 'OVERDUE';
        await locked.save({ transaction: nested });
        // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 10, 2026-10-05): o job só
        // publicava tool.loan.overdue (evento de integração externa via outbox) e mudava o
        // status — ninguém DENTRO do app era avisado que está com a ferramenta atrasada.
        // Mesma lacuna já corrigida nas rodadas 7 (insuranceRenewalAlertJob) e 9
        // (warrantyEscalationJob): evento publicado não é o mesmo que alerta recebido.
        await Notification.create(
          {
            groupId: locked.groupId,
            companyId: locked.companyId,
            userId: locked.personUserId,
            channel: 'IN_APP',
            title: 'Ferramenta com devolução atrasada',
            body: `A ferramenta do empréstimo ${locked.id} está atrasada (previsto para ${locked.dueAt}) — devolva ou regularize.`,
          },
          { transaction: nested }
        );
        notified += 1;
      });
      escalated += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[ToolLoanOverdueJob] Falha ao escalonar loan ${loan.id}: ${err.message}`);
    }
  }

  return { loansChecked: candidates.length, escalated, notified };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return escalateOverdueToolLoans(transaction);
  });
}

async function runToolLoanOverdueJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, loansChecked: 0, escalated: 0, notified: 0, errors: 0 };

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
        summary.loansChecked += result.loansChecked;
        summary.escalated += result.escalated;
        summary.notified += result.notified;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[ToolLoanOverdueJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ToolLoanOverdueJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.loansChecked} empréstimo(s) verificado(s), ${summary.escalated} escalonado(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function startToolLoanOverdueJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runToolLoanOverdueJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[ToolLoanOverdueJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runToolLoanOverdueJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[ToolLoanOverdueJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runToolLoanOverdueJob,
  startToolLoanOverdueJob,
  escalateOverdueToolLoans,
  processToolLoanOverdueForCompany: processCompany,
};
