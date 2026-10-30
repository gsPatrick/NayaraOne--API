'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros do registro de classificação (M9-D910 §4). Códigos novos levam GOV_; VALIDATION_ERROR é da lista fechada da plataforma. */
const retentionRequired = () => govError(422, 'GOV_CLASS_RETENTION_REQUIRED', 'Informe a política de retenção.');
const columnNotFound = () => govNotFound('Coluna não encontrada.');
const validation = (message, details) => govError(400, 'VALIDATION_ERROR', message, details);

module.exports = { retentionRequired, columnNotFound, validation };
