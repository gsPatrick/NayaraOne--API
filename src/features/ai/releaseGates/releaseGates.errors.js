'use strict';

const AppError = require('../../../utils/AppError');

/** Erros do portão de liberação (M9-D046). Código estável, mensagem em português, sem detalhe técnico. */
const incomplete = (missing) => new AppError(`Faltam aprovações para liberar a NAY em produção: ${missing.join(', ')}.`, 409, 'AI_PRODUCTION_GATE_INCOMPLETE', { missing });
const selfApproval = () => new AppError('Outra pessoa precisa aprovar a liberação em produção.', 403, 'AI_GATE_SELF_APPROVAL_BLOCKED');
const invalid = (message, details) => new AppError(message, 400, 'AI_GATE_INVALID', details);
const evidenceRequired = (item) => new AppError(`Informe a evidência (evidenceRef) para aprovar ${item}.`, 400, 'AI_GATE_EVIDENCE_REQUIRED', { item });
const notFound = () => new AppError('Aprovação não encontrada.', 404, 'AI_GATE_NOT_FOUND');

module.exports = { incomplete, selfApproval, invalid, evidenceRequired, notFound };
