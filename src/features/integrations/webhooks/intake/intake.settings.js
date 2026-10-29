'use strict';

const AppError = require('../../../../utils/AppError');

const tiposValidos = (texto) => typeof texto === 'string' && /^\s*[a-z0-9.+-]+\/[a-z0-9.+-]+(\s*,\s*[a-z0-9.+-]+\/[a-z0-9.+-]+)*\s*$/i.test(texto);

/**
 * Parâmetros da borda e do worker de webhooks (M9-D212 e M9-D213): só o dicionário de SETTINGS_SCHEMA; a leitura está em intake.params.js.
 * O tamanho máximo do corpo (integration.webhook.max_body_bytes) é declarado pela caixa de entrada (inbox.settings.js).
 */
const INTAKE_SETTINGS_SCHEMA = Object.freeze({
  // INT-P032: tempo máximo (ms) da rota até gravar e responder; passou disso responde 503 e o fornecedor reenvia.
  'integration.webhook.response_timeout_ms': { type: 'integer', min: 100, max: 60000 },
  // M9-D212: de quantos em quantos segundos o worker pega os eventos recebidos (livro: a cada 5 s) e quantos por rodada (livro: 50).
  'integration.webhook.worker_interval_s': { type: 'integer', min: 1, max: 3600 },
  'integration.webhook.worker_batch_size': { type: 'integer', min: 1, max: 500 },
  // INT-P027: diferença máxima (s) entre o horário assinado do evento e o relógio do servidor; acima disso é replay (401).
  'integration.webhook.timestamp_tolerance_s': { type: 'integer', min: 1, max: 86400 },
  // INT-P028: por quanto tempo (s) o identificador do evento fica retido para recusar reenvio, mesmo com o corpo já apagado.
  'integration.webhook.replay_window_s': { type: 'integer', min: 60, max: 2592000 },
  // INT-P029 e INT-P030: profundidade máxima e quantidade máxima de chaves do JSON; INT-P103 (M9-D213): tamanho máximo de um texto.
  'integration.webhook.max_json_depth': { type: 'integer', min: 1, max: 200 },
  'integration.webhook.max_keys': { type: 'integer', min: 1, max: 100000 },
  'integration.webhook.max_string_length': { type: 'integer', min: 100, max: 10000000 },
  // M9-D213: tipos de conteúdo aceitos (o formulário só vale para o fornecedor que o declara no adapter).
  'integration.webhook.accepted_content_types': {
    type: 'string',
    validate: (key, value) => {
      if (!tiposValidos(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de tipos de conteúdo separados por vírgula (ex.: application/json,text/plain).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
});

module.exports = { INTAKE_SETTINGS_SCHEMA };
