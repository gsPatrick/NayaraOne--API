'use strict';

const { mktError } = require('../marketing.errors');

/** Erros da definição de automações (M9-D413). Mensagens em português. */
const incomplete = (items) => mktError(422, 'MKT_AUTOMATION_INCOMPLETE',
  `Faltam itens obrigatórios da automação: ${items.map((i) => i.field).join(', ')}.`, { items });
const versionImmutable = (details) => mktError(409, 'MKT_AUTOMATION_VERSION_IMMUTABLE', 'A versão publicada é imutável; crie uma nova versão.', details);
const actionUnknown = (details) => mktError(422, 'MKT_AUTOMATION_ACTION_UNKNOWN', 'Tipo de ação desconhecido.', details);
const notFound = () => mktError(404, 'MKT_AUTOMATION_NOT_FOUND', 'Automação não encontrada.');
const invalidBody = (message, details) => mktError(400, 'MKT_VALIDATION', message, details);
const reasonRequired = () => mktError(400, 'MKT_REASON_REQUIRED', 'Informe o motivo.');
const codeExists = (details) => mktError(409, 'MKT_AUTOMATION_CODE_EXISTS', 'Já existe uma automação com este código.', details);

module.exports = { incomplete, versionImmutable, actionUnknown, notFound, invalidBody, reasonRequired, codeExists };
