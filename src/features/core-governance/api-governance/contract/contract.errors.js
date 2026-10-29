'use strict';

const { govError } = require('../../governance.errors');

/**
 * Falhas do contract test (M9-D842 §4). Cada função devolve um "achado" { code, message, details } com o código e a mensagem do livro; o código GOV_ERROR_CODE_UNKNOWN é da M9-D843
 * (catálogo) e aqui só é usado na verificação. Nada é lançado: a suíte junta todos os achados de uma chamada e decide no fim.
 */
const finding = (err) => ({ code: err.code, message: err.message, details: err.details });

const schemaMismatch = (method, path, details) => finding(govError(422, 'GOV_RESPONSE_SCHEMA_MISMATCH', `A resposta de ${method} ${path} não segue o contrato.`, details));
const statusNotDocumented = (status, path, details) => finding(govError(422, 'GOV_STATUS_NOT_DOCUMENTED', `Status ${status} não está no contrato de ${path}.`, details));
const exampleMissing = (path, details) => finding(govError(422, 'GOV_CONTRACT_EXAMPLE_MISSING', `Falta exemplo positivo ou negativo para ${path}.`, details));
const exampleInvalid = (reason, details) => finding(govError(422, 'GOV_CONTRACT_EXAMPLE_INVALID', `O exemplo do contract test é inválido: ${reason}.`, details));
const errorCodeUnknown = (code) => finding(govError(422, 'GOV_ERROR_CODE_UNKNOWN', `Código de erro não catalogado: ${code}.`, { code }));
const dbNotDisposable = (reason) => finding(govError(422, 'GOV_CONTRACT_DB_NOT_DISPOSABLE', `O contract test só roda em banco descartável: ${reason}.`, { reason }));

module.exports = { finding, schemaMismatch, statusNotDocumented, exampleMissing, exampleInvalid, errorCodeUnknown, dbNotDisposable };
