'use strict';

const { Op, literal } = require('sequelize');
const AppError = require('../../utils/AppError');
const { IntegrationError } = require('../../models');
const { recordError, resolveError } = require('../integrations/errors');

/**
 * Erros de integração do Correspondente (Marco 8). Desde o Marco 9 (M9-D207) este serviço DELEGA ao serviço genérico
 * (integration.integration_errors), com as mesmas assinaturas e os mesmos códigos de erro de antes. O id do caso fica em
 * `source_ref_id` (atributo `financingCaseId`); a tabela correspondent.integration_errors virou legado somente leitura.
 * A mensagem é de negócio e passa pelo sanitizador único: corpo do provider, stack e segredo não entram.
 */
function sourceOf(operation) {
  const op = String(operation || '');
  if (op.startsWith('webhook')) return 'WEBHOOK';
  if (op === 'status') return 'SYNC';
  return 'DISPATCH';
}

async function recordIntegrationError(
  { groupId, companyId, financingCaseId, providerCode, operation, errorCode, message },
  transaction
) {
  return recordError(
    { groupId, companyId },
    {
      providerCode: String(providerCode || '').slice(0, 32),
      source: sourceOf(operation),
      sourceRefId: financingCaseId || null,
      operation: String(operation || '').slice(0, 40),
      errorClass: 'UNKNOWN',
      // errorCode pode vir de uma exceção qualquer (código longo ou que nem é texto): cabe na coluna.
      errorCode: typeof errorCode === 'string' && errorCode ? errorCode : 'INTEGRATION_FAILED',
      message,
    },
    transaction
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
  // A tabela genérica guarda erros de todas as famílias; esta lista continua sendo só a do financiamento.
  const where = {
    groupId,
    companyId,
    [Op.or]: [{ providerCode: ['sandbox', 'manual'] }, literal(`"IntegrationError"."provider_code" IN (SELECT code FROM integration.providers WHERE domain = 'FINANCING')`)],
  };
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
  const text = String(note || '').trim();
  try {
    return await resolveError(
      errorId,
      { note: text },
      { groupId, companyId, userId: actorUserId },
      transaction,
      { auditAction: 'correspondent.integration_error.resolved' }
    );
  } catch (err) {
    // Mantém os códigos que o Correspondente já devolvia.
    if (err.code === 'INTEGRATION_ERROR_ALREADY_CLOSED') {
      throw AppError.conflict('Este erro de integração já foi resolvido.', 'INTEGRATION_ERROR_ALREADY_RESOLVED');
    }
    if (err.code === 'INTEGRATION_ERROR_NOTE_REQUIRED') {
      throw AppError.badRequest('Informe o que foi feito para resolver (mínimo 3 caracteres).', 'INTEGRATION_ERROR_VALIDATION');
    }
    throw err;
  }
}

module.exports = { recordIntegrationError, listIntegrationErrors, resolveIntegrationError };
