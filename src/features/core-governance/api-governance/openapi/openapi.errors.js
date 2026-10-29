'use strict';

const { govError } = require('../../governance.errors');

/** Erros e códigos de saída do lint do contrato OpenAPI (M9-D840 §4). */
const EXIT = Object.freeze({ OK: 0, FAILED: 1, INVALID: 2 });

const invalid = (reason) => govError(422, 'GOV_OPENAPI_INVALID', `O contrato OpenAPI é inválido: ${reason}.`, { reason });
const breakingMessage = (major, rule, where) => `Mudança incompatível dentro da major ${major}: ${rule} em ${where}.`;
const undocumentedMessage = (method, path) => `Rota sem documentação no contrato: ${method} ${path}.`;
const BREAKING_CODE = 'GOV_OPENAPI_BREAKING_CHANGE';
const UNDOCUMENTED_CODE = 'GOV_OPENAPI_ROUTE_UNDOCUMENTED';

module.exports = { EXIT, invalid, breakingMessage, undocumentedMessage, BREAKING_CODE, UNDOCUMENTED_CODE };
