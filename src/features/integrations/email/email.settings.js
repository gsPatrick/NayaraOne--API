'use strict';

const AppError = require('../../../utils/AppError');

const EXTENSOES_RE = /^\s*[a-z0-9]{2,5}(\s*,\s*[a-z0-9]{2,5}){0,19}\s*$/i;

/** Parâmetros do e-mail de saída (M9-D234): só o dicionário de SETTINGS_SCHEMA; a leitura está em email.params.js. */
const EMAIL_SETTINGS_SCHEMA = Object.freeze({
  // INT-P079: soma máxima, em bytes, dos anexos de uma mensagem (padrão 10 MiB).
  'integration.email.max_attachment_bytes': { type: 'integer', min: 1024, max: 104857600 },
  // Extensões de anexo aceitas (livro: a forma mínima de tornar "anexos autorizados" verificável).
  'integration.email.attachment_allowed_types': {
    type: 'string',
    validate: (key, value) => {
      if (!EXTENSOES_RE.test(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 20 extensões (letras e números) separadas por vírgula (ex.: pdf,png,jpg,docx,xlsx).`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // Classificação máxima do documento anexado (escala de documentos). O livro fixa CONFIDENTIAL como teto; a empresa só pode baixar.
  'integration.email.max_attachment_classification': { type: 'string', enum: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'] },
  // Destinatários por mensagem (para, cópia e cópia oculta somados) e anexos por mensagem.
  'integration.email.max_recipients': { type: 'integer', min: 1, max: 500 },
  'integration.email.max_attachments': { type: 'integer', min: 1, max: 50 },
});

module.exports = { EMAIL_SETTINGS_SCHEMA };
