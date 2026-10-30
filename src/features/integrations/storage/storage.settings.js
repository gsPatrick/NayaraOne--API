'use strict';

const AppError = require('../../../utils/AppError');

/** Parâmetros do armazenamento de objetos (M9-D242): só o dicionário de SETTINGS_SCHEMA; a leitura está em storage.params.js. */
const STORAGE_SETTINGS_SCHEMA = Object.freeze({
  // INT-P088: teto, em segundos, da validade de uma URL assinada (o pedido maior é reduzido a este valor).
  'integration.storage.signed_url_max_ttl_s': { type: 'integer', min: 30, max: 86400 },
  // Driver usado quando a empresa não tem connection ativa de armazenamento (o disco do servidor é o padrão; o sandbox serve ao laboratório).
  'integration.storage.default_provider': {
    type: 'string',
    validate: (key, value) => {
      if (!['storage-local-disk', 'storage-sandbox'].includes(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ser storage-local-disk ou storage-sandbox.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // Maior objeto aceito pelo armazenamento, em bytes (o padrão acompanha o limite de upload externo).
  'integration.storage.max_object_bytes': { type: 'integer', min: 1024, max: 1073741824 },
});

module.exports = { STORAGE_SETTINGS_SCHEMA };
