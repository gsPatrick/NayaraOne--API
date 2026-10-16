'use strict';

const { FiscalReconciliation } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

const VALID_TYPES = ['FINANCE_X_NFSE', 'COMMISSION_X_FISCAL', 'DIMOB_X_CONTRACTS'];

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * reconcile — Marco 8 Fase 12. "Qualquer diferença abre uma fiscal_reconciliation/issue, nunca é
 * ignorada silenciosamente" (citação literal do Caderno). Quando expectedAmount === actualAmount,
 * NÃO cria registro (não há issue nenhuma pra abrir — zero diferença não é "ignorar
 * silenciosamente", é confirmar que bate). Qualquer diferença != 0, por menor que seja, abre.
 */
async function reconcile(reconciliationType, referenceId, expectedAmount, actualAmount, actorUserId, groupId, companyId, transaction) {
  if (!VALID_TYPES.includes(reconciliationType)) {
    throw AppError.badRequest(`Tipo de reconciliação inválido: "${reconciliationType}".`, 'FISCAL_RECONCILIATION_VALIDATION');
  }
  const expected = round2(expectedAmount);
  const actual = round2(actualAmount);
  const difference = round2(expected - actual);

  if (difference === 0) {
    return null;
  }

  const reconciliation = await FiscalReconciliation.create(
    {
      groupId, companyId,
      reconciliationType,
      referenceId,
      expectedAmount: expected,
      actualAmount: actual,
      differenceAmount: difference,
      status: 'OPEN',
      detectedAt: new Date(),
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId: actorUserId || null,
      action: 'correspondent.fiscal.reconciliation_opened',
      entityType: 'FiscalReconciliation',
      entityId: reconciliation.id,
      reason: `Divergência fiscal (${reconciliationType}) detectada: esperado R$ ${expected.toFixed(2)}, real R$ ${actual.toFixed(2)}, diferença R$ ${difference.toFixed(2)}.`,
    },
    transaction
  );

  return reconciliation;
}

async function resolveReconciliation(reconciliationId, reasonText, actorUserId, groupId, companyId, transaction) {
  const reconciliation = await FiscalReconciliation.findOne({ where: { id: reconciliationId, groupId, companyId }, transaction });
  if (!reconciliation) {
    throw AppError.notFound('Reconciliação fiscal não encontrada.', 'FISCAL_RECONCILIATION_NOT_FOUND');
  }
  if (reconciliation.status === 'RESOLVED') {
    throw AppError.conflict('Esta reconciliação já foi resolvida.', 'FISCAL_RECONCILIATION_ALREADY_RESOLVED');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest('Resolver uma reconciliação exige um motivo documentado.', 'FISCAL_RECONCILIATION_REASON_REQUIRED');
  }

  reconciliation.status = 'RESOLVED';
  reconciliation.resolvedAt = new Date();
  await reconciliation.save({ transaction });

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.fiscal.reconciliation_resolved',
      entityType: 'FiscalReconciliation',
      entityId: reconciliation.id,
      reason: `Reconciliação fiscal resolvida: ${reasonText}.`,
    },
    transaction
  );

  return reconciliation;
}

async function listReconciliations(status, groupId, companyId, transaction) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  return FiscalReconciliation.findAll({ where, order: [['detected_at', 'DESC']], transaction });
}

module.exports = { reconcile, resolveReconciliation, listReconciliations, VALID_TYPES };
