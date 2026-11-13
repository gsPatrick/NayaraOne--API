'use strict';

/**
 * invalidateStaleOpenPaymentIntents — F-05 (conferência ao vivo 20/10/2026, Caderno §9 e §17). Depois de uma
 * edição do lançamento, toda intenção de pagamento ainda não enviada ao banco (PENDING ou APPROVED) cujo retrato
 * (snapshot) não bate mais com o lançamento é cancelada, com motivo em português e auditoria antes/depois. Fica
 * livre para uma nova intenção sobre a versão atual. Intenção já enviada ao banco (SUBMITTING/SUBMITTED) não é
 * tocada aqui: a mudança de destino nesse estágio é barrada em updateFinancialEntry.
 */
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const { NOT_SUBMITTED_STATUSES, currentEntryHash } = require('../../domain/payment-intent');

async function invalidateStaleOpenPaymentIntents(entry, actorUserId, transaction) {
  const found = await intents.findForEntryForUpdate(entry.id, NOT_SUBMITTED_STATUSES, transaction);
  if (found.length === 0) return 0;
  const currentHash = currentEntryHash(entry);
  let invalidated = 0;
  for (const intent of found) {
    if (intent.snapshotHash === currentHash) continue;
    const beforeJson = intent.toJSON();
    intent.status = 'CANCELLED';
    intent.cancelledAt = new Date();
    intent.cancelReason = 'Lançamento alterado após a aprovação: a intenção de pagamento foi invalidada. Crie uma nova intenção sobre a versão atual.';
    intent.updatedBy = actorUserId || null;
    await intents.save(intent, transaction);
    await registrarAuditoria(
      {
        groupId: intent.groupId,
        companyId: intent.companyId,
        actorUserId,
        action: 'finance.payment_intent.stale',
        entityType: 'PaymentIntent',
        entityId: intent.id,
        beforeJson,
        afterJson: intent.toJSON(),
        reason: intent.cancelReason,
      },
      transaction
    );
    invalidated += 1;
  }
  return invalidated;
}

module.exports = { invalidateStaleOpenPaymentIntents };
