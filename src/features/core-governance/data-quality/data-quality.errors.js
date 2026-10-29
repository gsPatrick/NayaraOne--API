'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros de dados mestres (M9-D804 §4). Códigos novos levam GOV_; VALIDATION_ERROR e PERMISSION_DENIED são da lista fechada da plataforma. */
const ownerConflict = () => govError(409, 'GOV_DOMAIN_OWNER_EXISTS', 'Informe um único responsável (owner) por domínio.');
const assigneeInactive = () => govError(422, 'GOV_ASSIGNEE_INACTIVE', 'Só usuário ativo da empresa pode ser designado.');
const domainInvalid = () => govError(400, 'GOV_DOMAIN_INVALID', 'Domínio de dados inválido.');
const validation = (message, details) => govError(400, 'VALIDATION_ERROR', message, details);
const userNotFound = () => govNotFound('Usuário não encontrado.');

module.exports = { ownerConflict, assigneeInactive, domainInvalid, validation, userNotFound };
