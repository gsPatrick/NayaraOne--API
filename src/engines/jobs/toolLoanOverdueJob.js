'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, InventoryToolLoan, Notification, Task } = require('../../models');
const { publishToolLoanOverdue } = require('../../features/inventory/inventoryEvents.service');

/**
 * toolLoanOverdueJob (Marco 7 — Caderno item 14/EST-TS-13) — varre tool_loans OPEN com
 * due_at vencido e publica `tool.loan.overdue`. Mesmo padrão (por grupo/empresa, SET LOCAL,
 * uma transação por empresa) de warrantyEscalationJob.js/feedbackCaseAlertJob.js.
 *
 * Idempotência: a chave do evento inclui `lockVersion` do loan — só muda de valor quando o
 * loan sofre alguma alteração real, então rodar o job repetidamente sem nada mudar não
 * duplica o evento no outbox (dedupe por idempotencyKey já garantido por publishDomainEvent).
 *
 * GAP REAL CORRIGIDO (auditoria de conformidade EST-TS-13, 2026-10-08): o contrato ("ferramenta
 * atrasada gera tarefa/escalonamento") esperava níveis crescentes de escalonamento e uma Task
 * real de verdade, não só uma transição única OPEN -> OVERDUE com uma Notification solta.
 * `escalationLevel` (NONE/WARNING/CRITICAL/OVERDUE) replica o MESMO padrão de
 * `computeEscalationLevel`/`warrantyEscalationJob.js` (WarrantyCase), calculado agora a partir
 * de quantos dias já passaram do `dueAt` (direção invertida: aqui o prazo já venceu, lá ainda
 * estava por vencer). A Notification antiga é mantida intacta (transição OPEN -> OVERDUE);
 * por cima dela, quando o nível é CRITICAL/OVERDUE, cria-se também uma Task real em
 * `core.tasks` atribuída ao responsável pela ferramenta, com prioridade crescendo com o nível
 * — mesmo padrão de Task polimórfica já usado em `missingDailyReportJob.js`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * computeToolLoanEscalationLevel — função pura, mesmo papel de `computeEscalationLevel`
 * (maintenanceCases.service.js), mas para o lado "atrasado" do prazo (dueAt no passado):
 *   - ainda não venceu (dueAt no futuro ou agora)     -> NONE
 *   - venceu há até 1 dia                             -> WARNING
 *   - venceu há mais de 1 dia e até 3 dias             -> CRITICAL
 *   - venceu há mais de 3 dias                        -> OVERDUE
 * Limiares reaproveitados de `warrantyEscalationJob`/`computeEscalationLevel` por falta de algo
 * melhor no contrato (EST-TS-13 não especifica janelas), ajustando apenas o "sentido" do prazo.
 */
function computeToolLoanEscalationLevel(dueAt, now = new Date()) {
  if (!dueAt) return 'NONE';
  const diffMs = new Date(now).getTime() - new Date(dueAt).getTime();
  if (diffMs <= 0) return 'NONE';
  const diffDays = diffMs / DAY_MS;
  if (diffDays <= 1) return 'WARNING';
  if (diffDays <= 3) return 'CRITICAL';
  return 'OVERDUE';
}

const NOTIFIABLE_LEVELS = ['CRITICAL', 'OVERDUE'];
const TASK_PRIORITY_BY_LEVEL = { CRITICAL: 'HIGH', OVERDUE: 'URGENT' };
async function escalateOverdueToolLoans(transaction, now = new Date()) {
  // BUG REAL CORRIGIDO: a versão anterior republicava tool.loan.overdue em TODO ciclo do job
  // pra qualquer loan OPEN vencido, sem nenhum marcador de "já avisado" — como o
  // idempotencyKey incluía só lockVersion (que não muda sozinho), a 2ª execução sempre batia
  // em "duplicate key value violates unique constraint" e o job falhava pra aquela empresa a
  // cada 30min, indefinidamente. Fix: transição OPEN -> OVERDUE (status já previsto no schema,
  // nunca usado) é o marcador — só dispara o evento na transição, nunca de novo pro mesmo loan.
  // Inclui também loans já OVERDUE (não só OPEN): escalationLevel precisa continuar subindo
  // (WARNING -> CRITICAL -> OVERDUE) enquanto a ferramenta não for devolvida, mesmo depois da
  // transição única de status OPEN -> OVERDUE já ter acontecido num ciclo anterior.
  const candidates = await InventoryToolLoan.findAll({
    where: { status: { [Op.in]: ['OPEN', 'OVERDUE'] }, dueAt: { [Op.ne]: null, [Op.lt]: now } },
    transaction,
  });

  // Resiliência por item: cada loan é sua própria savepoint implícita via transação aninhada
  // do Sequelize — se UM loan falhar (ex.: evento órfão de idempotencyKey colidindo por algum
  // motivo externo), os demais ainda são processados em vez de travar a empresa inteira.
  let escalated = 0;
  let notified = 0;
  for (const loan of candidates) {
    const newLevel = computeToolLoanEscalationLevel(loan.dueAt, now);
    if (newLevel === loan.escalationLevel && loan.status === 'OVERDUE') continue;

    try {
      await sequelize.transaction({ transaction }, async (nested) => {
        // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 44, 2026-10-05): a varredura
        // inicial (findAll acima) não trava as linhas — em deploy com múltiplas réplicas do
        // mesmo processo Node, dois processos podem selecionar o MESMO loan antes de qualquer
        // UPDATE comitar, e ambos criariam uma Notification duplicada (o outbox é protegido
        // por idempotencyKey, mas a notificação IN_APP não era). Re-busca com lock pessimista
        // e reconfirma o estado DENTRO da transação aninhada — se outro processo já escalonou
        // este loan nesse intervalo, este processo pula silenciosamente, sem duplicar nada.
        const locked = await InventoryToolLoan.findByPk(loan.id, { transaction: nested, lock: nested.LOCK.UPDATE });
        if (!locked || !['OPEN', 'OVERDUE'].includes(locked.status)) return;

        const confirmedLevel = computeToolLoanEscalationLevel(locked.dueAt, now);
        if (confirmedLevel === locked.escalationLevel && locked.status === 'OVERDUE') return;

        const wasOpen = locked.status === 'OPEN';
        if (wasOpen) {
          // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 10, 2026-10-05): o job só
          // publicava tool.loan.overdue (evento de integração externa via outbox) e mudava o
          // status — ninguém DENTRO do app era avisado que está com a ferramenta atrasada.
          // Mesma lacuna já corrigida nas rodadas 7 (insuranceRenewalAlertJob) e 9
          // (warrantyEscalationJob): evento publicado não é o mesmo que alerta recebido.
          await publishToolLoanOverdue(locked, nested);
          locked.status = 'OVERDUE';
        }
        locked.escalationLevel = confirmedLevel;
        await locked.save({ transaction: nested });

        // Mantém a Notification original (NÃO removida): dispara ao transicionar pra OVERDUE
        // na primeira vez, independente do nível de escalonamento calculado.
        if (wasOpen) {
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
        }

        // GAP REAL CORRIGIDO (EST-TS-13, 2026-10-08): contrato pede tarefa/escalonamento de
        // verdade, não só alerta — níveis CRITICAL/OVERDUE criam uma Task real em core.tasks
        // (mesmo padrão polimórfico de missingDailyReportJob.js), com prioridade crescendo
        // junto com o nível. Dedupe por relatedEntityId + título (contém o nível) evita
        // duplicar a MESMA Task se o job rodar de novo sem o nível ter mudado.
        if (NOTIFIABLE_LEVELS.includes(confirmedLevel)) {
          const taskTitle = `Ferramenta atrasada (${confirmedLevel}) — empréstimo ${locked.id}`;
          const existingTask = await Task.findOne({
            where: {
              relatedEntityType: 'inventory.tool_loans',
              relatedEntityId: locked.id,
              title: taskTitle,
              status: { [Op.ne]: 'CANCELED' },
            },
            transaction: nested,
          });
          if (!existingTask) {
            await Task.create(
              {
                groupId: locked.groupId,
                companyId: locked.companyId,
                assignedToUserId: locked.personUserId,
                title: taskTitle,
                description: `A ferramenta do empréstimo ${locked.id} (ativo ${locked.assetId}) está atrasada desde ${locked.dueAt} — nível de escalonamento: ${confirmedLevel}. Devolva ou regularize.`,
                relatedEntityType: 'inventory.tool_loans',
                relatedEntityId: locked.id,
                status: 'OPEN',
                priority: TASK_PRIORITY_BY_LEVEL[confirmedLevel] || 'NORMAL',
              },
              { transaction: nested }
            );
          }
        }
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
  computeToolLoanEscalationLevel,
};
