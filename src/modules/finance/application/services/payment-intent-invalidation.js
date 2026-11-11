'use strict';

/**
 * Invalidação das intenções de pagamento ainda não enviadas ao banco (DRAFT, PENDING_APPROVAL, APPROVED) — Caderno §9 "Favorecido e dados
 * bancários usados em payment_intent ficam congelados no snapshot. Qualquer troca de banco/agência/conta/chave PIX/beneficiário invalida
 * toda aprovação anterior"; §17 "Favorecido alterado -> Invalida approvals + alerta"; FIN-TS-003.
 *
 *  - invalidateStaleOpenPaymentIntents (F-05): depois de editar o LANÇAMENTO, a intenção cujo retrato não bate mais é cancelada.
 *  - invalidateForBeneficiaryChange (sondas V2-P1 e P7): depois de trocar banco/agência/conta/PIX/titular da CONTA de destino, toda intenção
 *    não enviada que congelou essa conta é cancelada, o pedido de aprovação dela e as aprovações de baixa dos lançamentos que pagam essa
 *    conta viram STALE, e um caso de anomalia (alerta) é aberto. A intenção já no banco (EXECUTING) não é tocada: ela leva o favorecido
 *    congelado na aprovação.
 * Cada invalidação é auditada com antes/depois; o motivo fica em português na intenção.
 */
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { PaymentIntent, ApprovalRequest, FinancialEntry } = require('../../../../models');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const { NOT_SUBMITTED_STATUSES } = require('../../domain/payment-intent');
const { OPEN_FOR_SETTLEMENT_STATUSES } = require('../../domain/financial-entry');
const { currentApprovable } = require('./payment-snapshot');
const workflow = require('./approval-workflow');
const { createAnomalyCase } = require('./anomaly-cases.service');

async function cancelIntent(intent, reason, action, actorUserId, transaction) {
  const beforeJson = intent.toJSON();
  intent.status = 'CANCELED';
  intent.cancelledAt = new Date();
  intent.cancelReason = reason;
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  if (intent.approvalRequestId) {
    const approval = await ApprovalRequest.findByPk(intent.approvalRequestId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
    if (approval) await workflow.markStale(approval, reason, actorUserId, transaction);
  }
  await registrarAuditoria(
    { groupId: intent.groupId, companyId: intent.companyId, actorUserId, action, entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason },
    transaction
  );
}

async function invalidateStaleOpenPaymentIntents(entry, actorUserId, transaction) {
  const found = await intents.findForEntryForUpdate(entry.id, NOT_SUBMITTED_STATUSES, transaction);
  let invalidated = 0;
  for (const intent of found) {
    const legacy = !intent.snapshotJson || !intent.snapshotJson.snapshotVersion;
    if (!legacy && (await currentApprovable(intent, entry, transaction)).hash === intent.snapshotHash) continue;
    await cancelIntent(intent, 'Lançamento alterado após a preparação: a intenção de pagamento e a aprovação dela foram invalidadas. Prepare uma nova intenção sobre a versão atual.',
      'finance.payment_intent.stale', actorUserId, transaction);
    invalidated += 1;
  }
  return invalidated;
}

async function invalidateForBeneficiaryChange(bankAccount, changedFields, actorUserId, transaction) {
  const reason = `Favorecido alterado (${changedFields.join(', ')}) na conta de destino depois da preparação: a intenção de pagamento e as aprovações anteriores ` +
    'foram invalidadas (Caderno §9). Prepare uma nova intenção, que congela o favorecido atual, e peça a aprovação de novo.';
  const affected = await PaymentIntent.findAll({ where: { bankAccountId: bankAccount.id, status: NOT_SUBMITTED_STATUSES }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  for (const intent of affected) await cancelIntent(intent, reason, 'finance.payment_intent.beneficiary_changed', actorUserId, transaction);

  // Aprovações de baixa (sem intenção) dos lançamentos em aberto que pagam esta conta também deixam de valer.
  const openEntries = await FinancialEntry.findAll({ attributes: ['id'], where: { bankAccountId: bankAccount.id, status: OPEN_FOR_SETTLEMENT_STATUSES }, transaction });
  let staleApprovals = 0;
  if (openEntries.length) {
    const approvals = await ApprovalRequest.findAll({
      where: { relatedEntityType: 'FinancialEntry', relatedEntityId: openEntries.map((e) => e.id), status: ['PENDING', 'APPROVED'] },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const approval of approvals) if (await workflow.markStale(approval, reason, actorUserId, transaction)) staleApprovals += 1;
  }

  if (affected.length || staleApprovals) {
    await createAnomalyCase(
      {
        groupId: bankAccount.groupId,
        companyId: bankAccount.companyId,
        caseType: 'BENEFICIARY_CHANGED_AFTER_APPROVAL',
        riskLevel: 'HIGH',
        relatedEntityType: 'BankAccount',
        relatedEntityId: bankAccount.id,
        reason: `Dados do favorecido (${changedFields.join(', ')}) alterados com ${affected.length} intenção(ões) de pagamento e ${staleApprovals} aprovação(ões) ` +
          'ainda não enviadas ao banco: todas foram invalidadas. Confirme a troca com o favorecido por um canal independente antes de pagar.',
      },
      actorUserId,
      transaction
    );
  }
  return { intents: affected.length, approvals: staleApprovals };
}

module.exports = { invalidateStaleOpenPaymentIntents, invalidateForBeneficiaryChange };
