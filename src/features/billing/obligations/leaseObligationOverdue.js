'use strict';

const { Op } = require('sequelize');
const {
  UtilityObligation, UtilityReimbursement, OwnershipTransferTask, LeaseObligationCycle, Contract, FinancialEntry, Task, Notification, OutboxEvent,
} = require('../../../models');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { legalDeadlineZone } = require('../../../modules/legal/shared/legalRules.params');
const { leaseObligationParams } = require('./leaseObligationParams');
const { advanceAllObligations } = require('./obligationCycles.service');
const { todayIn, addDays } = require('./obligationCycleDates');

/**
 * Obrigação locatícia vencida (livro §12 "Pendência gera alerta/cobrança; não some quando contrato encerra"; §18 evento
 * lease.obligation.overdue; DEC-074: um só emissor, chave lease.obligation.overdue:<obligation_id>:<source_type>:<source_id>).
 * Roda no job da cobrança, por empresa, sob a RLS do tenant. Três origens:
 *  - CYCLE: ciclo da obrigação (IPTU, condomínio, água...) não pago com comprovante até o vencimento + carência
 *    (`billing.utility_proof_grace_days`) vira OVERDUE;
 *  - TRANSFER: troca de titularidade pendente depois do prazo (`due_date`; sem prazo próprio, criação + `locacao.titularidade.prazo_dias`);
 *  - REIMBURSEMENT: reembolso a receber pendente há mais de `billing.reimbursement_overdue_alert_days` do vencimento.
 * Para cada pendência, uma vez: evento, ALERTA (notificação a quem cuida do contrato) e COBRANÇA (tarefa de cobrar a parte
 * responsável), com auditoria. Nada é apagado nem fechado: a pendência continua até ser paga/comprovada/dispensada.
 */
const UTILITY_LABELS = { WATER: 'água', ELECTRICITY: 'energia elétrica', GAS: 'gás', CONDO: 'condomínio', IPTU: 'IPTU', SPU: 'SPU (laudêmio/foro)', OTHER: 'outra despesa' };
const PARTY_LABELS = { LANDLORD: 'locador', TENANT: 'locatário', COMPANY: 'imobiliária' };
const SOURCE_TEXT = { CYCLE: 'vencimento sem comprovante', TRANSFER: 'troca de titularidade atrasada', REIMBURSEMENT: 'reembolso não recebido' };
const ENTRY_SETTLED = ['SETTLED', 'CANCELLED', 'REVERSED']; // recebido por inteiro, cancelado ou estornado (finance/domain/financial-entry.js)

const eventKey = (obligationId, sourceType, sourceId) => `lease.obligation.overdue:${obligationId}:${sourceType}:${sourceId}`;

async function alreadyFlagged(obligationId, sourceType, sourceId, transaction) {
  const keys = [eventKey(obligationId, sourceType, sourceId)];
  if (sourceType === 'TRANSFER') keys.push(`lease.obligation.overdue:${sourceId}`); // chave antiga (antes da DEC-074), já publicada
  return Boolean(await OutboxEvent.findOne({ where: { idempotencyKey: keys }, attributes: ['id'], transaction }));
}

/** Evento + alerta + cobrança de uma pendência vencida; devolve a tarefa de cobrança. */
async function flagOverdue({ obligation, sourceType, sourceId, aggregateType, dueOn, owedBy, extraPayload = {} }, now, transaction) {
  const contract = await Contract.findByPk(obligation.contractId, { attributes: ['id', 'contractNumber', 'createdBy'], transaction });
  const owner = contract ? contract.createdBy : null;
  const label = UTILITY_LABELS[obligation.utilityType] || 'obrigação';
  const contractLabel = contract && contract.contractNumber ? contract.contractNumber : 'sem número';
  const party = PARTY_LABELS[owedBy] || 'parte responsável';
  await publishDomainEvent(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      aggregateType,
      aggregateId: sourceId,
      eventType: 'lease.obligation.overdue',
      payload: { obligationId: obligation.id, utilityObligationId: obligation.id, contractId: obligation.contractId, utilityType: obligation.utilityType, sourceType, sourceId, dueOn, owedBy, ...extraPayload },
      idempotencyKey: eventKey(obligation.id, sourceType, sourceId),
    },
    transaction
  );
  const task = await Task.create(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      assignedToUserId: owner,
      title: `Cobrança: ${label} — ${SOURCE_TEXT[sourceType]} (contrato ${contractLabel})`.slice(0, 255),
      description: `Cobrar do ${party} a pendência de ${label} do contrato ${contractLabel}, vencida em ${dueOn}. A pendência continua aberta até ser comprovada, recebida ou dispensada com motivo.`,
      relatedEntityType: `lease_obligation.${sourceType.toLowerCase()}`,
      relatedEntityId: sourceId,
      dueAt: now,
      status: 'OPEN',
      priority: 'HIGH',
      createdBy: null,
      updatedBy: null,
    },
    { transaction }
  );
  if (owner) {
    await Notification.create(
      {
        groupId: obligation.groupId, companyId: obligation.companyId, userId: owner, channel: 'IN_APP',
        title: 'Obrigação da locação vencida', body: `${label} do contrato ${contractLabel}: ${SOURCE_TEXT[sourceType]} desde ${dueOn}. Cobrança aberta para o ${party}.`,
        createdBy: null, updatedBy: null,
      },
      { transaction }
    );
  }
  await registrarAuditoria(
    {
      groupId: obligation.groupId, companyId: obligation.companyId, actorUserId: null, action: 'billing.lease_obligation.overdue',
      entityType: aggregateType, entityId: sourceId, beforeJson: { vencida: false, origem: sourceType },
      afterJson: { vencida: true, origem: sourceType, vencimento: dueOn, cobrancaTaskId: task.id, alertado: owner || null },
      reason: `Obrigação locatícia vencida (${SOURCE_TEXT[sourceType]}): evento, alerta e cobrança abertos.`,
    },
    transaction
  );
  return task;
}

async function overdueCycles(today, params, now, transaction) {
  const limit = addDays(today, -params.proofGraceDays);
  const cycles = await LeaseObligationCycle.findAll({ where: { status: 'OPEN', dueOn: { [Op.lt]: limit } }, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
  let flagged = 0;
  for (const cycle of cycles) {
    const obligation = await UtilityObligation.findByPk(cycle.obligationId, { transaction });
    const before = cycle.toJSON();
    cycle.status = 'OVERDUE';
    cycle.overdueSince = now;
    if (!(await alreadyFlagged(obligation.id, 'CYCLE', cycle.id, transaction))) {
      const task = await flagOverdue({ obligation, sourceType: 'CYCLE', sourceId: cycle.id, aggregateType: 'LeaseObligationCycle', dueOn: cycle.dueOn, owedBy: obligation.responsibleParty, extraPayload: { period: cycle.dueOn } }, now, transaction);
      cycle.collectionTaskId = task.id;
      flagged += 1;
    }
    await cycle.save({ transaction });
    await registrarAuditoria({ groupId: cycle.groupId, companyId: cycle.companyId, actorUserId: null, action: 'billing.lease_obligation_cycle.overdue', entityType: 'LeaseObligationCycle', entityId: cycle.id, beforeJson: before, afterJson: cycle.toJSON(), reason: `Vencimento ${cycle.dueOn} sem comprovante depois de ${params.proofGraceDays} dia(s) de carência.` }, transaction);
  }
  return flagged;
}

async function overdueTransfers(today, params, now, transaction) {
  const createdLimit = new Date(now.getTime() - params.transferDays * 86400000);
  const tasks = await OwnershipTransferTask.findAll({
    where: { status: 'PENDING', [Op.or]: [{ dueDate: { [Op.lt]: today } }, { dueDate: null, created_at: { [Op.lt]: createdLimit } }] },
    transaction,
  });
  let flagged = 0;
  for (const task of tasks) {
    const obligation = await UtilityObligation.findByPk(task.utilityObligationId, { transaction });
    if (!obligation || (await alreadyFlagged(obligation.id, 'TRANSFER', task.id, transaction))) continue;
    const dueOn = task.dueDate || addDays(todayIn('UTC', new Date(task.get('created_at'))), params.transferDays);
    await flagOverdue({ obligation, sourceType: 'TRANSFER', sourceId: task.id, aggregateType: 'OwnershipTransferTask', dueOn, owedBy: 'COMPANY', extraPayload: { id: task.id, pendingSince: task.get('created_at') } }, now, transaction);
    flagged += 1;
  }
  return flagged;
}

async function overdueReimbursements(today, params, now, transaction) {
  const reimbursements = await UtilityReimbursement.findAll({ where: { status: 'PENDING' }, transaction });
  let flagged = 0;
  for (const reimbursement of reimbursements) {
    const entry = reimbursement.financialEntryId ? await FinancialEntry.findByPk(reimbursement.financialEntryId, { attributes: ['id', 'status', 'dueAt'], transaction }) : null;
    if (entry && ENTRY_SETTLED.includes(entry.status)) continue; // já recebido no Financeiro
    const due = todayIn('UTC', new Date((entry && entry.dueAt) || reimbursement.get('created_at')));
    if (addDays(due, params.reimbursementAlertDays) >= today) continue;
    const obligation = await UtilityObligation.findByPk(reimbursement.utilityObligationId, { transaction });
    if (!obligation || (await alreadyFlagged(obligation.id, 'REIMBURSEMENT', reimbursement.id, transaction))) continue;
    await flagOverdue({ obligation, sourceType: 'REIMBURSEMENT', sourceId: reimbursement.id, aggregateType: 'UtilityReimbursement', dueOn: due, owedBy: reimbursement.owedByParty, extraPayload: { amount: Number(reimbursement.amount) } }, now, transaction);
    flagged += 1;
  }
  return flagged;
}

/** Corpo do job para UMA empresa (transação com o tenant já definido). */
async function processLeaseObligations(transaction, { now = new Date() } = {}) {
  const sample = await UtilityObligation.findOne({ attributes: ['groupId', 'companyId'], transaction });
  if (!sample) return { checked: 0, flagged: 0, cyclesCreated: 0 };
  const tenant = { groupId: sample.groupId, companyId: sample.companyId };
  const params = await leaseObligationParams(tenant, transaction);
  const today = todayIn(await legalDeadlineZone(tenant, transaction), now);
  const advanced = await advanceAllObligations(today, transaction);
  const cycles = await overdueCycles(today, params, now, transaction);
  const transfers = await overdueTransfers(today, params, now, transaction);
  const reimbursements = await overdueReimbursements(today, params, now, transaction);
  return { checked: advanced.obligations, cyclesCreated: advanced.created, flagged: cycles + transfers + reimbursements, cycles, transfers, reimbursements };
}

module.exports = { processLeaseObligations, eventKey };
