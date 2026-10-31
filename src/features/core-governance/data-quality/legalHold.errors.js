'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros da retenção legal (M9-D912 §4). Códigos novos levam GOV_; VALIDATION_ERROR é da lista fechada da plataforma. */
const disposalBlocked = (details) => govError(409, 'GOV_HOLD_BLOCKS_DISPOSAL', 'Este registro está sob retenção legal e não pode ser apagado ou anonimizado.', details);
const reasonRequired = () => govError(422, 'GOV_HOLD_REASON_REQUIRED', 'Informe o motivo e a referência do processo.');
const codeDuplicate = () => govError(409, 'GOV_HOLD_CODE_DUPLICATE', 'Já existe uma retenção com este código.');
const releaseReasonRequired = () => govError(422, 'GOV_HOLD_RELEASE_REASON_REQUIRED', 'Informe o motivo da liberação.');
const scopeRequired = () => govError(422, 'GOV_HOLD_SCOPE_REQUIRED', 'Defina o escopo da retenção.');
const scopeInvalid = (message, details) => govError(422, 'GOV_HOLD_SCOPE_INVALID', message, details);
const alreadyReleased = () => govError(409, 'GOV_HOLD_ALREADY_RELEASED', 'Esta retenção legal já foi liberada.');
const validation = (message, details) => govError(400, 'VALIDATION_ERROR', message, details);
const notFound = () => govNotFound('Retenção legal não encontrada.');
const targetNotFound = (details) => govNotFound('Registro do escopo não encontrado.', details);

module.exports = { disposalBlocked, reasonRequired, codeDuplicate, releaseReasonRequired, scopeRequired, scopeInvalid, alreadyReleased, validation, notFound, targetNotFound };
