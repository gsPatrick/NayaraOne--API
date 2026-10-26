'use strict';

const { IntegrationError } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Grava correspondent.integration_errors quando a integração falha.
 * A mensagem é de negócio. Corpo do provider, stack e segredo não entram.
 */
async function recordIntegrationError(
  { groupId, companyId, financingCaseId, providerCode, operation, errorCode, message },
  transaction
) {
  return IntegrationError.create(
    {
      groupId,
      companyId,
      financingCaseId: financingCaseId || null,
      providerCode: String(providerCode || '').slice(0, 32),
      operation: String(operation || '').slice(0, 40),
      // errorCode pode vir de uma exceção qualquer (código longo ou que nem é texto): cabe na coluna.
      errorCode: (typeof errorCode === 'string' && errorCode ? errorCode : 'INTEGRATION_FAILED').slice(0, 64),
      message: String(message || '').slice(0, 500),
    },
    { transaction }
  );
}

const OPERATION_LABEL = {
  submit: 'Envio do caso',
  status: 'Consulta de status',
  webhook: 'Webhook do provider',
  'webhook.proposal': 'Proposta recebida do provider',
  upload_document: 'Envio de documento ao provider',
  appraisal: 'Avaliação do imóvel',
  simulate: 'Simulação',
  cancel: 'Cancelamento no provider',
  chargeback: 'Estorno de comissão no Financeiro',
};

/**
 * listIntegrationErrors — erros de integração do correspondente (o evento
 * `integration.correspondent.failed` já sai; aqui a pessoa enxerga a lista e dá baixa).
 * Só mensagem de negócio: o corpo do provider nunca foi gravado.
 */
async function listIntegrationErrors({ status, limit = 200 } = {}, groupId, companyId, transaction) {
  const where = { groupId, companyId };
  if (status) {
    if (!['OPEN', 'RESOLVED'].includes(status)) {
      throw AppError.badRequest('O filtro "status" deve ser OPEN ou RESOLVED.', 'INTEGRATION_ERROR_VALIDATION');
    }
    where.status = status;
  }
  const parsed = Number(limit);
  const rowLimit = Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 500) : 200;
  const rows = await IntegrationError.findAll({ where, order: [['created_at', 'DESC']], limit: rowLimit, transaction });
  return rows.map((row) => ({ ...row.toJSON(), operationLabel: OPERATION_LABEL[row.operation] || row.operation }));
}

async function resolveIntegrationError(errorId, note, actorUserId, groupId, companyId, transaction) {
  // Trava a linha: duas resoluções simultâneas não gravam duas auditorias (a segunda vê "já resolvido").
  const error = await IntegrationError.findOne({ where: { id: errorId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!error) {
    throw AppError.notFound('Erro de integração não encontrado.', 'INTEGRATION_ERROR_NOT_FOUND');
  }
  if (error.status === 'RESOLVED') {
    throw AppError.conflict('Este erro de integração já foi resolvido.', 'INTEGRATION_ERROR_ALREADY_RESOLVED');
  }
  const text = String(note || '').trim();
  if (text.length < 3) {
    throw AppError.badRequest('Informe o que foi feito para resolver (mínimo 3 caracteres).', 'INTEGRATION_ERROR_VALIDATION');
  }
  error.status = 'RESOLVED';
  error.resolvedAt = new Date();
  error.resolvedBy = actorUserId || null;
  error.resolutionNote = text.slice(0, 500);
  await error.save({ transaction });
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.integration_error.resolved',
      entityType: 'IntegrationError',
      entityId: error.id,
      beforeJson: { status: 'OPEN' },
      afterJson: { status: 'RESOLVED' },
      reason: `Erro de integração "${error.errorCode}" (${error.operation}) resolvido por uma pessoa: ${text}.`,
    },
    transaction
  );
  return error;
}

module.exports = { recordIntegrationError, listIntegrationErrors, resolveIntegrationError };
