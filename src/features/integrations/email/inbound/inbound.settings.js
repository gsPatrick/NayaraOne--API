'use strict';

const AppError = require('../../../../utils/AppError');

const PREFIXOS_RE = /^\s*[A-Za-z0-9]{2,12}(\s*,\s*[A-Za-z0-9]{2,12}){0,9}\s*$/;

/** Parâmetros do e-mail recebido (M9-D235): só o dicionário de SETTINGS_SCHEMA; a leitura está em inbound.params.js. */
const INBOUND_SETTINGS_SCHEMA = Object.freeze({
  // Anexos aceitos por mensagem recebida; o que passar disso não entra (a mensagem registra o excesso como bloqueado).
  'integration.email.inbound_max_attachments': { type: 'integer', min: 1, max: 100 },
  // Prefixos da referência no assunto: `[PROC-1234]`. A lista é de texto simples, nunca expressão regular.
  'integration.email.inbound_reference_prefixes': {
    type: 'string',
    validate: (key, value) => {
      if (!PREFIXOS_RE.test(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 10 prefixos (letras e números, de 2 a 12) separados por vírgula (ex.: PROC).`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // Verifica os anexos (antivírus e tipo real) na própria chegada da mensagem; desligado, a verificação fica com a rodada da quarentena.
  'integration.email.inbound_verify_immediately': { type: 'boolean' },
  // Tamanho máximo do corpo guardado (já mascarado); o excedente é cortado.
  'integration.email.inbound_body_max_chars': { type: 'integer', min: 100, max: 200000 },
  // De quantos em quantos minutos se lêem as mensagens novas das connections de e-mail configuradas para leitura periódica (`inboundMode: POLL`); webhook não depende disso.
  'integration.email.inbound_poll_interval_min': { type: 'integer', min: 1, max: 1440 },
});

module.exports = { INBOUND_SETTINGS_SCHEMA };
