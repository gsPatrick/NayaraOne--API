'use strict';

const AppError = require('../../../utils/AppError');
const { parseBackoffList } = require('../../../engines/events/outboxBackoffParse');

const lista = (texto) => typeof texto === 'string' && /^\s*[a-z0-9-]+(\s*,\s*[a-z0-9-]+)*\s*$/i.test(texto);

/** Parâmetros da caixa de entrada de webhooks (M9-D203): só o dicionário de SETTINGS_SCHEMA; a leitura está em inbox.params.js. */
const INBOX_SETTINGS_SCHEMA = Object.freeze({
  // INT-P033: tentativas de processamento até o evento ir para a fila morta.
  'integration.inbox.max_attempts': { type: 'integer', min: 1, max: 50 },
  // INT-P034: dias que o corpo bruto de um evento processado fica guardado (depois só o hash).
  'integration.inbox.raw_retention_days': { type: 'integer', min: 1, max: 3650 },
  // INT-P035: dias que a linha do evento fica guardada.
  'integration.inbox.retention_days': { type: 'integer', min: 1, max: 3650 },
  // INT-P102: dias que o corpo de um evento em fila morta por tentativas esgotadas fica guardado para reprocessar.
  'integration.inbox.dlq_retry_retention_days': { type: 'integer', min: 1, max: 365 },
  // INT-P026: tamanho máximo (bytes) do corpo bruto guardado; acima disso só o hash e o resumo ficam.
  'integration.webhook.max_body_bytes': { type: 'integer', min: 1024, max: 52428800 },
  // M9-D203: esperas (ms) entre as tentativas de processar um evento; a última se repete.
  'integration.inbox.retry_backoff_ms': {
    type: 'string',
    validate: (key, value) => {
      if (!parseBackoffList(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de milissegundos inteiros positivos separados por vírgula (ex.: 60000,300000).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  // M9-D203: cabeçalhos da entrega que ficam gravados com o evento (authorization e cookies nunca são gravados).
  'integration.inbox.header_allowlist': {
    type: 'string',
    validate: (key, value) => {
      if (!lista(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de nomes de cabeçalho separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
});

module.exports = { INBOX_SETTINGS_SCHEMA };
