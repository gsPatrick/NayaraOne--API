'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do parametros.csv (M9-D230), usados quando a empresa não configurou. */
const PADROES = Object.freeze({
  sessionWindowH: 24,
  maxMediaBytes: 16777216,
  optoutKeywords: 'PARAR,SAIR,CANCELAR',
  mediaLinkTtlMin: 15,
  mediaMaxClassification: 'PUBLIC',
  mediaAllowedTypes: 'image/jpeg,image/png,image/webp,application/pdf,video/mp4,audio/ogg',
  transactionalRequiresOptIn: false,
});

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);
const lista = (v, padrao) => String(typeof v === 'string' && v.trim() ? v : padrao).split(',').map((s) => s.trim()).filter(Boolean);

/** Tira acento, pontuação e caixa: a palavra de saída "Parar." vale como "PARAR". */
const normalizar = (texto) => String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toUpperCase();

async function readWhatsappParams(tenant, transaction) {
  const [janela, maxMidia, palavras, ttl, classe, tipos, transacional] = await Promise.all([
    getSetting('integration.whatsapp.session_window_h', tenant, transaction, PADROES.sessionWindowH),
    getSetting('integration.whatsapp.max_media_bytes', tenant, transaction, PADROES.maxMediaBytes),
    getSetting('integration.whatsapp.optout_keywords', tenant, transaction, PADROES.optoutKeywords),
    getSetting('integration.whatsapp.media_link_ttl_min', tenant, transaction, PADROES.mediaLinkTtlMin),
    getSetting('integration.whatsapp.media_max_classification', tenant, transaction, PADROES.mediaMaxClassification),
    getSetting('integration.whatsapp.media_allowed_types', tenant, transaction, PADROES.mediaAllowedTypes),
    getSetting('integration.whatsapp.transactional_requires_opt_in', tenant, transaction, PADROES.transactionalRequiresOptIn),
  ]);
  return {
    sessionWindowH: inteiro(janela, PADROES.sessionWindowH, 1),
    maxMediaBytes: inteiro(maxMidia, PADROES.maxMediaBytes, 1),
    optoutKeywords: lista(palavras, PADROES.optoutKeywords).map(normalizar),
    mediaLinkTtlMin: inteiro(ttl, PADROES.mediaLinkTtlMin, 1),
    mediaMaxClassification: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'].includes(classe) ? classe : PADROES.mediaMaxClassification,
    mediaAllowedTypes: lista(tipos, PADROES.mediaAllowedTypes).map((t) => t.toLowerCase()),
    transactionalRequiresOptIn: transacional === true,
  };
}

module.exports = { PADROES, readWhatsappParams, normalizar };
