'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros da retenção (M9-D911 §4). Códigos novos levam GOV_; VALIDATION_ERROR é da lista fechada da plataforma. */
const legalBasisRequired = () => govError(422, 'GOV_RETENTION_LEGAL_BASIS_REQUIRED', 'Informe a base legal da política de retenção.');
const legalBasisInvalid = (details) => govError(422, 'GOV_RETENTION_LEGAL_BASIS_INVALID', 'A base legal informada não existe no catálogo.', details);
const periodInvalid = (details) => govError(422, 'GOV_RETENTION_PERIOD_INVALID', 'O prazo de retenção é inválido.', details);
const holdExceptionRequired = () => govError(422, 'GOV_RETENTION_HOLD_EXCEPTION_REQUIRED', 'Toda política deve respeitar a retenção legal (legal hold).');
const dryRunRequired = () => govError(409, 'GOV_RETENTION_DRY_RUN_REQUIRED', 'Execute a simulação antes de aplicar.');
const alreadyApplied = () => govError(409, 'GOV_RETENTION_ALREADY_APPLIED', 'Esta rodada de retenção já foi aplicada.');
const inProgress = () => govError(409, 'GOV_RETENTION_RUN_IN_PROGRESS', 'Esta rodada de retenção está sendo aplicada agora.');
const applyFailed = (details) => govError(500, 'GOV_RETENTION_APPLY_FAILED', 'A aplicação parou num lote; os lotes concluídos foram mantidos e o restante pode ser retomado.', details);
const unsupported = (code, message, details) => govError(422, code, message, details);
const targetTaken = (details) => govError(409, 'GOV_RETENTION_TARGET_TAKEN', 'Este tipo de dado já pertence a outra política de retenção.', details);
const autoApplyUnsafe = () => govError(422, 'GOV_RETENTION_AUTO_APPLY_UNSAFE', 'A aplicação automática só vale para dados técnicos de integração.');
const validation = (message, details) => govError(400, 'VALIDATION_ERROR', message, details);
const notFound = () => govNotFound('Política de retenção não encontrada.');
const runNotFound = () => govNotFound('Rodada de retenção não encontrada.');

module.exports = { legalBasisRequired, legalBasisInvalid, periodInvalid, holdExceptionRequired, dryRunRequired, alreadyApplied, inProgress, applyFailed, unsupported, targetTaken, autoApplyUnsafe, validation, notFound, runNotFound };
