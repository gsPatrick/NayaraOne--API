'use strict';

const { govError } = require('../governance.errors');

/** Erros da política DLP (M9-D820 §4). Mensagens em português, as do livro/da demanda. */
const denied = (details) => govError(403, 'GOV_DLP_DENIED', 'Esta ação não é permitida para dados desta classificação.', details);
const floorViolation = (details) => govError(422, 'GOV_DLP_FLOOR_VIOLATION', 'Esta classificação exige justificativa, verificação em duas etapas, auditoria e expiração.', details);
const policyInvalid = (details) => govError(400, 'GOV_DLP_POLICY_INVALID', 'Classificação ou ação inválida.', details);
const policyFieldInvalid = (field) => govError(400, 'GOV_DLP_POLICY_INVALID', `Valor inválido para "${field}" na política.`, { field });

const requestInvalid = (message, details) => govError(400, 'GOV_DLP_REQUEST_INVALID', message, details);
const idempotencyConflict = () => govError(409, 'GOV_DLP_IDEMPOTENCY_CONFLICT', 'Esta chave de idempotência já foi usada em outro pedido.');

module.exports = { denied, floorViolation, policyInvalid, policyFieldInvalid, requestInvalid, idempotencyConflict };
