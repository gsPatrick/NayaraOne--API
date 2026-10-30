'use strict';

const AppError = require('../../../utils/AppError');

const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/;

/** Parâmetros da quarentena (M9-D247): só o dicionário de SETTINGS_SCHEMA; a leitura está em quarantine.params.js. */
const QUARANTINE_SETTINGS_SCHEMA = Object.freeze({
  // INT-P061: tamanho máximo de um upload externo (25 MiB).
  'integration.upload.max_bytes': { type: 'integer', min: 1024, max: 1073741824 },
  // INT-P062: horas até o arquivo sem resultado ser descartado (72).
  'integration.upload.quarantine_ttl_hours': { type: 'integer', min: 1, max: 720 },
  // Anti zip-bomb: níveis de arquivo compactado dentro de arquivo compactado e razão máxima de descompressão (livro: 3 níveis e 100:1).
  'integration.upload.zip_max_depth': { type: 'integer', min: 1, max: 10 },
  'integration.upload.zip_max_ratio': { type: 'integer', min: 2, max: 1000 },
  // Tipos reais aceitos (lista de tipos de mídia separados por vírgula): o tipo declarado e o detectado pelo conteúdo precisam estar nela.
  'integration.upload.allowed_types': {
    type: 'string',
    validate: (key, value) => {
      const itens = String(value).split(',').map((s) => s.trim());
      if (itens.length < 1 || itens.length > 40 || itens.some((m) => !MIME_RE.test(m))) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 40 tipos de mídia (como application/pdf) separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
});

module.exports = { QUARANTINE_SETTINGS_SCHEMA };
