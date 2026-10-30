'use strict';

const AppError = require('../../../utils/AppError');
const { IntegrationError } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { CLOSED_STATUSES, NOTE_MIN, NOTE_MAX } = require('./errors.constants');
const { getResolveHandler } = require('./errors.hooks');

const DECISION_RE = /^[A-Z][A-Z_]{2,39}$/;

const OUTCOMES = Object.freeze(['RESOLVED', 'IGNORED']);

/**
 * resolveError — encerra um erro (RESOLVED) ou o descarta como ruído (IGNORED), sempre com nota de 3 a 500 caracteres.
 * Trava a linha com FOR UPDATE: de duas resoluções simultâneas uma vence e a outra recebe 409.
 * `decision` (opcional): decisão humana entregue ao tratador registrado do código do erro (errors.hooks).
 * `opts.auditAction`/`opts.reason` deixam o Correspondente manter o texto da auditoria que já tinha.
 */
async function resolveError(id, { note, outcome = 'RESOLVED', decision } = {}, ctx, transaction, opts = {}) {
  if (decision !== undefined && decision !== null && !DECISION_RE.test(String(decision))) {
    throw AppError.badRequest('A decisão informada é inválida.', 'INTEGRATION_ERROR_INVALID');
  }
  if (!OUTCOMES.includes(outcome)) {
    throw AppError.badRequest(`O desfecho deve ser um de: ${OUTCOMES.join(', ')}.`, 'INTEGRATION_ERROR_INVALID');
  }
  const error = await IntegrationError.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!error) throw AppError.notFound('Erro de integração não encontrado.', 'INTEGRATION_ERROR_NOT_FOUND');
  if (CLOSED_STATUSES.includes(error.status)) {
    throw AppError.conflict('Este erro já foi encerrado.', 'INTEGRATION_ERROR_ALREADY_CLOSED');
  }
  const text = String(note ?? '').trim();
  if (text.length < NOTE_MIN || text.length > NOTE_MAX) {
    throw AppError.unprocessable(`Informe a nota de resolução (${NOTE_MIN} a ${NOTE_MAX} caracteres).`, 'INTEGRATION_ERROR_NOTE_REQUIRED');
  }
  if (outcome === 'IGNORED' && error.status !== 'OPEN') {
    throw AppError.conflict('Só um erro em aberto pode ser ignorado.', 'INTEGRATION_ERROR_INVALID_TRANSITION');
  }
  const antes = error.status;
  const depois = { status: outcome, resolvedBy: ctx.userId || null, resolvedAt: new Date(), resolutionNote: text };
  await error.update(depois, { transaction });
  await registrarAuditoria(
    {
      groupId: ctx.groupId,
      companyId: ctx.companyId,
      actorUserId: ctx.userId || null,
      action: opts.auditAction || (outcome === 'IGNORED' ? 'integration.error.ignored' : 'integration.error.resolved'),
      entityType: 'IntegrationError',
      entityId: error.id,
      beforeJson: { status: antes },
      afterJson: { status: outcome, resolvedAt: depois.resolvedAt },
      reason: opts.reason || `Erro de integração "${error.errorCode}" (${error.providerCode}) ${outcome === 'IGNORED' ? 'ignorado' : 'resolvido'} por uma pessoa: ${text}.`,
    },
    transaction
  );
  // M9-D237: a decisão humana chega ao módulo dono do código do erro (por exemplo, o Financeiro rejeita o pagamento de valor divergente), na mesma transação.
  const tratador = decision ? getResolveHandler(error.errorCode) : null;
  if (tratador) await tratador({ error, decision: String(decision), ctx, transaction });
  return error;
}

module.exports = { resolveError, OUTCOMES };
