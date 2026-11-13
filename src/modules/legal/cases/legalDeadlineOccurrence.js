'use strict';

const { Task } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { formatInZone } = require('./legalDeadlineDates');

/**
 * Livro §15 "Prazo crítico vencido abre ocorrência HIGH/CRITICAL": prazo PENDING vencido com criticidade HIGH ou CRITICAL
 * tem UMA ocorrência (tarefa com essa prioridade, atribuída ao responsável). Vale também quando a criticidade sobe DEPOIS
 * do primeiro alerta de vencido (o job confere a ocorrência a cada rodada, não só quando a severidade piora).
 * occurrence_task_id impede abrir de novo.
 */
const OCCURRENCE_CRITICALITIES = ['HIGH', 'CRITICAL'];
const LABEL = { HIGH: 'alta', CRITICAL: 'crítica' };

function needsOccurrence(deadline, severity) {
  return severity === 'OVERDUE' && OCCURRENCE_CRITICALITIES.includes(deadline.criticality) && !deadline.occurrenceTaskId;
}

/** Abre a ocorrência e grava occurrenceTaskId na instância (quem chama salva o prazo). */
async function openDeadlineOccurrence(deadline, { legalCase, recipientUserId, now, zone }, transaction) {
  const occurrence = await Task.create(
    {
      groupId: deadline.groupId,
      companyId: deadline.companyId,
      assignedToUserId: recipientUserId || null,
      title: `Ocorrência ${LABEL[deadline.criticality] || 'importante'}: prazo jurídico vencido`,
      description: `"${deadline.description}" (processo ${legalCase ? legalCase.caseNumber || 'sem número' : 'não encontrado'}) venceu em ${formatInZone(deadline.dueAt, zone)} sem conclusão.`,
      relatedEntityType: 'legal.legal_deadlines',
      relatedEntityId: deadline.id,
      dueAt: now,
      status: 'OPEN',
      priority: deadline.criticality,
      createdBy: null,
      updatedBy: null,
    },
    { transaction }
  );
  deadline.occurrenceTaskId = occurrence.id;
  await registrarAuditoria(
    {
      groupId: deadline.groupId,
      companyId: deadline.companyId,
      actorUserId: null,
      action: 'legal.deadline.occurrence_open',
      entityType: 'LegalDeadline',
      entityId: deadline.id,
      beforeJson: { occurrenceTaskId: null, criticality: deadline.criticality },
      afterJson: { occurrenceTaskId: occurrence.id, criticality: deadline.criticality, priority: occurrence.priority },
      reason: `Prazo "${deadline.description}" vencido com criticidade ${deadline.criticality}: ocorrência aberta.`,
    },
    transaction
  );
  return occurrence;
}

module.exports = { needsOccurrence, openDeadlineOccurrence, OCCURRENCE_CRITICALITIES };
