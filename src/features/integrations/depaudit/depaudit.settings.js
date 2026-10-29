'use strict';

const AppError = require('../../../utils/AppError');
const { parseList } = require('../http/sdkPolicy');

const PADRAO_PACOTE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/\*)?$|^@[a-z0-9._-]+\/\*$/i;

/** Parâmetros da auditoria de dependências (M9-D248): só o dicionário de SETTINGS_SCHEMA; a leitura está em depaudit.params.js. */
const DEPAUDIT_SETTINGS_SCHEMA = Object.freeze({
  // INT-P094: SDK de fornecedor com versão exata no package.json (sem ^, ~ nem latest).
  'integration.sdk.pin_exact': { type: 'boolean' },
  // INT-P095: pacotes tratados como SDK de fornecedor (só dentro de um adapter, versão exata, vigiados pela auditoria).
  'integration.sdk.denylist': {
    type: 'string',
    validate: (key, value) => {
      const itens = parseList(value);
      if (!itens.length || !itens.every((i) => PADRAO_PACOTE.test(i))) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de pacotes npm separados por vírgula (ex.: twilio,@aws-sdk/*).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  // INT-P096: validade máxima, em dias, de uma exceção da auditoria (o livro fixa 30; a empresa pode apertar).
  'integration.sdk.audit_exception_max_days': { type: 'integer', min: 1, max: 30 },
  // Hora (America/Sao_Paulo) a partir da qual a auditoria diária roda.
  'integration.sdk.audit_hour': { type: 'integer', min: 0, max: 23 },
});

module.exports = { DEPAUDIT_SETTINGS_SCHEMA };
