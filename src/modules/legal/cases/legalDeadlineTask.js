'use strict';

const { Task, LegalDeadline } = require('../../../models');
const { formatInZone } = require('./legalDeadlineDates');
const { legalDeadlineZone } = require('../shared/legalRules.params');

/**
 * Tarefa do prazo (Guia do Marcelo §12: `tasks.create({ responsibleUserId: d.responsibleUserId, dueAt: d.dueAt,
 * severity: d.severity, sourceType: 'LEGAL_DEADLINE', sourceId: d.id })`). Criada NA MESMA transação do prazo e
 * mantida em sincronia com ele: concluir -> DONE; cancelar -> CANCELLED; reabrir -> OPEN; remarcar -> due_at;
 * reatribuir (do prazo ou do processo) -> assigned_to_user_id. core.tasks não tem colunas source_type/source_id:
 * o par do Guia vive em related_entity_type = 'LEGAL_DEADLINE' / related_entity_id = id do prazo (a ocorrência de
 * prazo vencido do job usa 'legal.legal_deadlines', então as duas nunca se confundem). Prioridade = criticidade.
 */
const SOURCE_TYPE = 'LEGAL_DEADLINE';
const TASK_STATUS = { PENDING: 'OPEN', DONE: 'DONE', CANCELLED: 'CANCELLED' };

const effectiveResponsible = (deadline, legalCase) => deadline.responsibleUserId || (legalCase && legalCase.responsibleUserId) || null;

function describe(deadline, legalCase, zone) {
  const origem = deadline.sourceFileId ? `arquivo ${deadline.sourceFileId}` : deadline.sourceEventId ? `evento ${deadline.sourceEventId}` : deadline.sourceDocument || deadline.sourceEvent || 'não informada';
  return `Processo ${legalCase.caseNumber || legalCase.id}. Origem: ${origem}. Vence em ${formatInZone(deadline.dueAt, zone)}. Criticidade ${deadline.criticality}.`;
}

function taskFields(deadline, legalCase, zone) {
  return {
    assignedToUserId: effectiveResponsible(deadline, legalCase),
    title: `Prazo jurídico: ${deadline.description}`.slice(0, 255),
    description: describe(deadline, legalCase, zone),
    dueAt: deadline.dueAt,
    status: TASK_STATUS[deadline.status] || 'OPEN',
    priority: deadline.criticality || 'MEDIUM',
  };
}

// Fechamento M5 (§15): o texto da tarefa mostra o vencimento no fuso da empresa.
const zoneOf = (deadline, transaction) => legalDeadlineZone({ groupId: deadline.groupId, companyId: deadline.companyId }, transaction);

async function createDeadlineTask(deadline, legalCase, actorUserId, transaction) {
  const task = await Task.create(
    { groupId: deadline.groupId, companyId: deadline.companyId, relatedEntityType: SOURCE_TYPE, relatedEntityId: deadline.id, ...taskFields(deadline, legalCase, await zoneOf(deadline, transaction)), createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  deadline.taskId = task.id;
  await deadline.save({ transaction });
  return task;
}

/** Depois de salvar o prazo: alinha (ou cria, se for prazo legado pendente sem tarefa) a tarefa ao estado atual. */
async function syncDeadlineTask(deadline, legalCase, actorUserId, transaction) {
  const task = deadline.taskId ? await Task.findByPk(deadline.taskId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined }) : null;
  if (!task) return deadline.status === 'PENDING' ? createDeadlineTask(deadline, legalCase, actorUserId, transaction) : null;
  Object.assign(task, taskFields(deadline, legalCase, await zoneOf(deadline, transaction)), { updatedBy: actorUserId || null });
  if (task.changed()) await task.save({ transaction });
  return task;
}

/** Responsável do PROCESSO mudou: reatribui as tarefas dos prazos pendentes que dependem dele (sem responsável próprio). */
async function reassignCaseDeadlineTasks(legalCase, actorUserId, transaction) {
  const deadlines = await LegalDeadline.findAll({ where: { legalCaseId: legalCase.id, status: 'PENDING', responsibleUserId: null }, transaction });
  for (const deadline of deadlines) await syncDeadlineTask(deadline, legalCase, actorUserId, transaction);
}

module.exports = { SOURCE_TYPE, createDeadlineTask, syncDeadlineTask, reassignCaseDeadlineTasks, effectiveResponsible };
