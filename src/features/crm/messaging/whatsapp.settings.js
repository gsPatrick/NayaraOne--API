'use strict';

const AppError = require('../../../utils/AppError');

const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/;
const CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'];

const lista = (key, value, regra, max) => {
  const itens = String(value).split(',').map((s) => s.trim());
  if (itens.length < 1 || itens.length > max || itens.some((i) => !regra.test(i))) return null;
  return itens;
};

/**
 * Parâmetros do WhatsApp (M9-D230): só o dicionário de SETTINGS_SCHEMA; a leitura está em whatsapp.params.js. Padrões em Maturacao/demandas/parametros.csv.
 */
const WHATSAPP_SETTINGS_SCHEMA = Object.freeze({
  // INT-P071: janela de atendimento, em horas desde a última mensagem do cliente (livro: 24). Fora dela só modelo aprovado.
  'integration.whatsapp.session_window_h': { type: 'integer', min: 1, max: 168 },
  // INT-P072: tamanho máximo da mídia enviada (16 MiB).
  'integration.whatsapp.max_media_bytes': { type: 'integer', min: 1024, max: 104857600 },
  // INT-P073: palavras que, sozinhas numa mensagem recebida, revogam o consentimento do canal (separadas por vírgula).
  'integration.whatsapp.optout_keywords': {
    type: 'string',
    validate: (key, value) => {
      if (!lista(key, value, /^[\p{L}\p{N}]{1,40}$/u, 30)) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 30 palavras (só letras e números) separadas por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // Validade, em minutos, do link assinado que o fornecedor recebe para buscar a mídia (livro: 15).
  'integration.whatsapp.media_link_ttl_min': { type: 'integer', min: 1, max: 60 },
  // Maior classificação do arquivo que pode sair como mídia (padrão PUBLIC); RESTRICTED nunca sai. Em qualquer classe, quem envia precisa ter acesso ao arquivo.
  'integration.whatsapp.media_max_classification': {
    type: 'string',
    validate: (key, value) => {
      if (!CLASSES.includes(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ser um de: ${CLASSES.join(', ')}.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // Tipos de mídia aceitos pelo canal (tipos separados por vírgula).
  'integration.whatsapp.media_allowed_types': {
    type: 'string',
    validate: (key, value) => {
      if (!lista(key, value, MIME_RE, 40)) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 40 tipos de mídia (como image/png) separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // O transacional também exige consentimento explícito (OPT_IN)? Padrão não: o transacional sai a quem não revogou, como no CRM antes do Marco 9. Marketing sempre exige.
  'integration.whatsapp.transactional_requires_opt_in': { type: 'boolean' },
});

module.exports = { WHATSAPP_SETTINGS_SCHEMA };
