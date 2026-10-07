'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, Task, Opportunity, Notification } = require('../../models');
const { publishDomainEvent } = require('../events/outbox');
const { registrarAuditoria } = require('../audit/auditLog.service');

/**
 * crmTaskOverdueJob — item 5 do ciclo de auditoria externa (Marco 3).
 *
 * Contrato bruto confirmado:
 *   Guia do Marcelo §11 ("Próxima ação e SLA"): "Tarefa vencida escala conforme regra."
 *   Caderno Pessoas/Imóveis/CRM/Radar §17 ("Eventos mínimos"): lista `crm.task.overdue` entre
 *     os eventos mínimos do domínio.
 *   Guia do Marcelo §14 ("Eventos"): também lista `crm.task.overdue`... (nota: a segunda lista
 *     do Guia do Marcelo, mais curta, não repete esse evento — mas a lista "Eventos mínimos"
 *     do caderno físico é explícita e mais extensa; tratamos como obrigatória por constar lá).
 *
 * "core"."tasks" (ver opportunityTasks.service.js) é a MESMA tabela polimórfica usada por
 * legal/billing — tarefas de CRM são as linhas com `related_entity_type = 'crm.opportunities'`.
 * Este job segue EXATAMENTE o mesmo padrão estrutural de legalDeadlineAlertJob.js e
 * feedbackCaseAlertJob.js: varre por grupo/empresa com SET LOCAL, processa dentro de uma
 * transação de tenant, publica evento de domínio + Notification + audit log, com guarda de
 * idempotência para não reprocessar a mesma tarefa a cada rodada.
 *
 * Idempotência: usamos o próprio `status` da tarefa como guarda — ao escalonar, o job NÃO
 * altera o status (a tarefa continua OPEN/IN_PROGRESS até alguém resolvê-la; escalonar não é
 * concluir), e sim grava `escalatedAt` localmente via tabela de controle leve: como
 * core.tasks não tem coluna de escalonamento própria, usamos `description` como campo
 * imutável de negócio e dependemos de uma auditoria dedicada (`crm.task.job_escalation`) para
 * decidir se já escalamos — a query de candidatos filtra tarefas vencidas e usa ausência de
 * auditoria prévia da MESMA tarefa com essa ação como critério de "ainda não escalada".
 */

const RELATED_ENTITY_TYPE = 'crm.opportunities';
const ESCALATABLE_STATUSES = ['OPEN', 'IN_PROGRESS'];

async function findAlreadyEscalatedTaskIds(taskIds, transaction) {
  if (taskIds.length === 0) return new Set();
  const [rows] = await sequelize.query(
    `SELECT entity_id FROM audit.audit_log WHERE action = 'crm.task.job_escalation' AND entity_id IN (:taskIds)`,
    { replacements: { taskIds }, transaction }
  );
  return new Set(rows.map((r) => r.entity_id));
}

/**
 * escalateOverdueCrmTasks — corpo real do job para uma transação de tenant já aberta. Extraído
 * para que os testes exercitem o comportamento REAL dentro de withRollbackTenantTransaction.
 */
async function escalateOverdueCrmTasks(transaction, now = new Date()) {
  const overdue = await Task.findAll({
    where: {
      relatedEntityType: RELATED_ENTITY_TYPE,
      status: { [Op.in]: ESCALATABLE_STATUSES },
      dueAt: { [Op.ne]: null, [Op.lt]: now },
    },
    transaction,
  });

  if (overdue.length === 0) return { tasksChecked: 0, escalated: 0 };

  const alreadyEscalated = await findAlreadyEscalatedTaskIds(overdue.map((t) => t.id), transaction);

  let escalated = 0;
  for (const task of overdue) {
    if (alreadyEscalated.has(task.id)) continue;

    const opportunity = await Opportunity.findByPk(task.relatedEntityId, { transaction });

    // Notifica o responsável da tarefa (assignedToUserId) e, se diferente, o owner da
    // oportunidade — mesmo princípio de escalonamento de legalDeadlineAlertJob.js (responsável
    // + alvo adicional quando existir).
    const notifyUserIds = new Set();
    if (task.assignedToUserId) notifyUserIds.add(task.assignedToUserId);
    if (opportunity && opportunity.ownerUserId) notifyUserIds.add(opportunity.ownerUserId);

    for (const userId of notifyUserIds) {
      // eslint-disable-next-line no-await-in-loop
      await Notification.create(
        {
          groupId: task.groupId,
          companyId: task.companyId,
          userId,
          channel: 'IN_APP',
          title: 'Tarefa de CRM vencida',
          body: `"${task.title}" venceu em ${new Date(task.dueAt).toLocaleString('pt-BR')} e ainda não foi concluída.`,
          createdBy: null,
          updatedBy: null,
        },
        { transaction }
      );
    }

    await publishDomainEvent(
      {
        groupId: task.groupId,
        companyId: task.companyId,
        aggregateType: 'Task',
        aggregateId: task.id,
        eventType: 'crm.task.overdue',
        payload: { id: task.id, opportunityId: task.relatedEntityId, title: task.title, dueAt: task.dueAt },
        idempotencyKey: `crm.task.overdue:${task.id}`,
      },
      transaction
    );

    await registrarAuditoria(
      {
        groupId: task.groupId,
        companyId: task.companyId,
        actorUserId: null,
        action: 'crm.task.job_escalation',
        entityType: 'Task',
        entityId: task.id,
        afterJson: { dueAt: task.dueAt, notifiedUserIds: [...notifyUserIds] },
        reason: `Tarefa de CRM "${task.title}" (oportunidade ${task.relatedEntityId}) vencida: escalonamento automático via job.`,
      },
      transaction
    );

    escalated += 1;
  }

  return { tasksChecked: overdue.length, escalated };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return escalateOverdueCrmTasks(transaction);
  });
}

async function runCrmTaskOverdueJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, tasksChecked: 0, escalated: 0, errors: 0 };

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
      `${summary.tasksChecked} tarefa(s) vencida(s), ${summary.escalated} escalonada(s), ${summary.errors} erro(s).`
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
