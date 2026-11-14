'use strict';

const { Op } = require('sequelize');
const { UtilityObligation, LeaseObligationCycle, File } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { nextCycleDate } = require('./obligationCycleDates');

/**
 * Ciclo das obrigações da locação (fechamento M5, livro §12 "Cada obrigação possui responsável, periodicidade, comprovante e
 * status"; M5-A0171). A entrega das chaves dá o início e o primeiro vencimento (keysDeliveredObligations.consumer); daqui em
 * diante cada vencimento vira um ciclo (legal.lease_obligation_cycles, um por obrigação + data) e o próximo vencimento da
 * obrigação AVANÇA pela periodicidade. O pagamento é de um ciclo, com comprovante — e o ciclo é a chave natural do pagamento.
 */
const ACTIVE_OBLIGATION_STATUSES = ['ACTIVE', 'TRANSFER_PENDING', 'TRANSFERRED'];
const OPEN_CYCLE_STATUSES = ['OPEN', 'OVERDUE'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function findOrCreateCycle(obligation, dueOn, transaction) {
  const [cycle, created] = await LeaseObligationCycle.findOrCreate({
    where: { obligationId: obligation.id, dueOn },
    defaults: { groupId: obligation.groupId, companyId: obligation.companyId, contractId: obligation.contractId, status: 'OPEN' },
    transaction,
  });
  return { cycle, created };
}

/**
 * Avança uma obrigação até hoje: cria o ciclo de cada vencimento já chegado e o do próximo vencimento, e move next_due_on
 * para o primeiro vencimento futuro (ONE_TIME: um ciclo só). Idempotente.
 */
async function advanceObligation(obligation, today, transaction) {
  if (!obligation.startsOn || !obligation.nextDueOn || !ACTIVE_OBLIGATION_STATUSES.includes(obligation.status)) return { created: 0 };
  let created = 0;
  const before = obligation.nextDueOn;
  let due = obligation.nextDueOn;
  for (let guard = 0; guard < 400; guard += 1) {
    if ((await findOrCreateCycle(obligation, due, transaction)).created) created += 1;
    if (due > today) break;
    const next = nextCycleDate(due, obligation.periodicity || 'MONTHLY', obligation.dueDay);
    if (!next) break; // ONE_TIME: o único ciclo já existe
    due = next;
  }
  if (due !== before) {
    obligation.nextDueOn = due;
    await obligation.save({ transaction });
    await registrarAuditoria(
      {
        groupId: obligation.groupId, companyId: obligation.companyId, actorUserId: null, action: 'billing.lease_obligation.advance',
        entityType: 'UtilityObligation', entityId: obligation.id, beforeJson: { nextDueOn: before }, afterJson: { nextDueOn: due, ciclosCriados: created },
        reason: `Ciclo da obrigação avançado pela periodicidade ${obligation.periodicity || 'MONTHLY'}: próximo vencimento ${due}.`,
      },
      transaction
    );
  }
  return { created };
}

async function advanceAllObligations(today, transaction) {
  const obligations = await UtilityObligation.findAll({
    where: { status: ACTIVE_OBLIGATION_STATUSES, startsOn: { [Op.ne]: null }, nextDueOn: { [Op.ne]: null } },
    transaction,
  });
  let created = 0;
  for (const obligation of obligations) created += (await advanceObligation(obligation, today, transaction)).created;
  return { obligations: obligations.length, created };
}

async function listCycles(obligationId, transaction) {
  return LeaseObligationCycle.findAll({ where: { obligationId }, order: [['dueOn', 'ASC']], transaction });
}

/**
 * Ciclo que um pagamento quita: o informado (`cycleId`), o do vencimento informado (`referenceDueOn`, criado se ainda não existe)
 * ou, sem referência, o ciclo aberto mais antigo. Ciclo já pago ou dispensado não recebe outro pagamento (idempotência natural).
 */
async function resolvePaymentCycle(obligation, payload, transaction) {
  const { cycleId, referenceDueOn } = payload || {};
  let cycle = null;
  if (cycleId !== undefined && cycleId !== null) {
    if (typeof cycleId !== 'string' || !/^[0-9a-f-]{36}$/i.test(cycleId)) throw AppError.badRequest('"cycleId" deve ser o identificador de um ciclo.', 'UTILITY_PAYMENT_VALIDATION');
    cycle = await LeaseObligationCycle.findOne({ where: { id: cycleId, obligationId: obligation.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!cycle) throw AppError.notFound('Ciclo não encontrado nesta obrigação.', 'UTILITY_CYCLE_NOT_FOUND');
  } else if (referenceDueOn !== undefined && referenceDueOn !== null && referenceDueOn !== '') {
    if (typeof referenceDueOn !== 'string' || !DATE_RE.test(referenceDueOn) || Number.isNaN(Date.parse(`${referenceDueOn}T00:00:00Z`))) {
      throw AppError.badRequest('"referenceDueOn" deve ser o vencimento pago, no formato AAAA-MM-DD.', 'UTILITY_PAYMENT_VALIDATION');
    }
    await findOrCreateCycle(obligation, referenceDueOn, transaction);
    cycle = await LeaseObligationCycle.findOne({ where: { obligationId: obligation.id, dueOn: referenceDueOn }, transaction, lock: transaction.LOCK.UPDATE });
  } else {
    cycle = await LeaseObligationCycle.findOne({ where: { obligationId: obligation.id, status: OPEN_CYCLE_STATUSES }, order: [['dueOn', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (!cycle) throw AppError.badRequest('Informe o vencimento que está sendo pago ("referenceDueOn") — esta obrigação não tem ciclo em aberto.', 'UTILITY_PAYMENT_CYCLE_REQUIRED');
  }
  if (!OPEN_CYCLE_STATUSES.includes(cycle.status)) {
    throw AppError.conflict(`O vencimento ${cycle.dueOn} desta obrigação já está ${cycle.status === 'PAID' ? 'pago' : 'dispensado'}: o pagamento não é registrado de novo.`, 'UTILITY_CYCLE_ALREADY_SETTLED', { cycleId: cycle.id, status: cycle.status });
  }
  return cycle;
}

/** Comprovante do pagamento: arquivo real desta empresa, que não comprovou outro ciclo. */
async function assertProofFile(proofFileId, obligation, transaction) {
  if (!proofFileId) throw AppError.badRequest('Anexe o comprovante do pagamento ("proofFileId").', 'UTILITY_RECEIPT_REQUIRED');
  const file = typeof proofFileId === 'string' && /^[0-9a-f-]{36}$/i.test(proofFileId)
    ? await File.findOne({ where: { id: proofFileId, companyId: obligation.companyId }, attributes: ['id'], transaction })
    : null;
  if (!file) throw AppError.badRequest('O comprovante informado não existe ou não pertence a esta empresa.', 'UTILITY_RECEIPT_NOT_FOUND');
  const used = await LeaseObligationCycle.findOne({ where: { proofFileId: file.id }, attributes: ['id'], transaction });
  if (used) throw AppError.conflict('Este comprovante já foi usado em outro vencimento.', 'UTILITY_RECEIPT_ALREADY_USED');
  return file.id;
}

async function markCyclePaid(cycle, { proofFileId, amount, paidByParty, reimbursementId }, actorUserId, transaction) {
  const before = cycle.toJSON();
  Object.assign(cycle, { status: 'PAID', paidAt: new Date(), proofFileId, amount, paidByParty, reimbursementId: reimbursementId || null, updatedBy: actorUserId || null });
  await cycle.save({ transaction });
  await registrarAuditoria(
    {
      groupId: cycle.groupId, companyId: cycle.companyId, actorUserId, action: 'billing.lease_obligation_cycle.pay', entityType: 'LeaseObligationCycle', entityId: cycle.id,
      beforeJson: before, afterJson: cycle.toJSON(), reason: `Vencimento ${cycle.dueOn} pago por ${paidByParty}, com comprovante.`,
    },
    transaction
  );
  return cycle;
}

/** Dispensa de um ciclo (decisão registrada, com motivo): sai das pendências, nunca é apagado. */
async function waiveCycle(cycleId, payload, actorUserId, transaction) {
  const reason = String((payload && payload.reason) || '').trim();
  if (reason.length < 10) throw AppError.badRequest('Informe o motivo da dispensa (mínimo de 10 caracteres).', 'UTILITY_WAIVE_REASON_REQUIRED');
  const cycle = typeof cycleId === 'string' && /^[0-9a-f-]{36}$/i.test(cycleId) ? await LeaseObligationCycle.findByPk(cycleId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
  if (!cycle) throw AppError.notFound('Ciclo não encontrado.', 'UTILITY_CYCLE_NOT_FOUND');
  if (!OPEN_CYCLE_STATUSES.includes(cycle.status)) throw AppError.conflict('Este vencimento já está pago ou dispensado.', 'UTILITY_CYCLE_ALREADY_SETTLED');
  const before = cycle.toJSON();
  Object.assign(cycle, { status: 'WAIVED', waivedReason: reason.slice(0, 2000), updatedBy: actorUserId || null });
  await cycle.save({ transaction });
  await registrarAuditoria(
    {
      groupId: cycle.groupId, companyId: cycle.companyId, actorUserId, action: 'billing.lease_obligation_cycle.waive', entityType: 'LeaseObligationCycle', entityId: cycle.id,
      beforeJson: before, afterJson: cycle.toJSON(), reason: `Vencimento ${cycle.dueOn} dispensado: ${reason}`,
    },
    transaction
  );
  return cycle;
}

module.exports = {
  ACTIVE_OBLIGATION_STATUSES, OPEN_CYCLE_STATUSES,
  advanceObligation, advanceAllObligations, listCycles, resolvePaymentCycle, assertProofFile, markCyclePaid, waiveCycle,
};
