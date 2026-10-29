'use strict';

const { INTAKE_SETTINGS_SCHEMA } = require('./intake/intake.settings');

/**
 * Parâmetros do framework de webhooks (M9-D211): só o dicionário de SETTINGS_SCHEMA; a leitura está em webhooks.params.js.
 * O tamanho máximo do corpo (integration.webhook.max_body_bytes) é declarado pela caixa de entrada (inbox.settings.js).
 */
const WEBHOOK_SETTINGS_SCHEMA = Object.freeze({
  // INT-P025: o alias literal do livro POST /webhooks/:provider/:channel, na raiz da API, além de /v1/webhooks/:provider/:channel.
  'integration.webhook.alias_root_enabled': { type: 'boolean' },
  // INT-P031: chamadas por minuto, por IP e fornecedor, antes de consultar a connection (classe de limite WEBHOOK, contador compartilhado no banco).
  'integration.webhook.rate_limit_per_minute': { type: 'integer', min: 10, max: 100000 },
  // INT-P101: tamanho (caracteres) do token opaco do canal gerado ao criar a connection; o formato aceito vai de 24 a 48.
  'integration.webhook.channel_token_length': { type: 'integer', min: 24, max: 48 },
  ...INTAKE_SETTINGS_SCHEMA,
});

module.exports = { WEBHOOK_SETTINGS_SCHEMA };
