'use strict';

const AppError = require('../../../../utils/AppError');

const limite = (key, value, max, vazioOk) => {
  const s = typeof value === 'string' ? value.trim() : '';
  if ((!vazioOk && s.length === 0) || String(value).length > max) {
    throw AppError.badRequest(`O valor de "${key}" deve ser um texto${vazioOk ? '' : ' preenchido'} de até ${max} caracteres.`, 'SETTING_INVALID_VALUE', { key, value });
  }
};

/** Parâmetros da contingência do WhatsApp (M9-D227): dicionário de SETTINGS_SCHEMA; a leitura está em mc.params.js. Padrões em Maturacao/demandas/parametros.csv. */
const WHATSAPP_CONTINGENCY_SETTINGS_SCHEMA = Object.freeze({
  // O canal alternativo (e-mail) exige o consentimento explícito (OPT_IN) do contato no canal? Padrão sim: o livro pede "consentimento no canal alternativo".
  'integration.whatsapp.alternate_requires_opt_in': { type: 'boolean' },
  // Assunto e abertura do e-mail que leva a mensagem quando o WhatsApp está fora.
  'integration.whatsapp.alternate_email_subject': { type: 'string', validate: (key, value) => limite(key, value, 120, false) },
  'integration.whatsapp.alternate_email_intro': { type: 'string', validate: (key, value) => limite(key, value, 400, false) },
  // Modelo aprovado em que a mensagem vira quando a janela de 24 h venceu enquanto ela esperava na fila (vazio = sem modelo: vira tarefa para uma pessoa).
  'integration.whatsapp.expired_template_name': { type: 'string', validate: (key, value) => limite(key, value, 120, true) },
});

module.exports = { WHATSAPP_CONTINGENCY_SETTINGS_SCHEMA };
