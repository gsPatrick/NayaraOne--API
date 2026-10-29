'use strict';

/**
 * M9-D698 (3.3) — parâmetro do cache de resposta dos painéis do BI (aba "BI e Centro de Comando" em /painel/configuracoes).
 *
 *  analytics.cache.ttl_segundos   por quanto tempo uma resposta pronta vale (padrão do livro: 60 s); o evento de refresh da empresa a descarta antes
 *
 * Fica em security/ porque a chave do cache (cacheKey.js) é da M9-D700 e a camada dashboards não importa settings.service.
 */
const CACHE_KEYS = Object.freeze({ TTL_SECONDS: 'analytics.cache.ttl_segundos' });
const CACHE_DEFAULTS = Object.freeze({ [CACHE_KEYS.TTL_SECONDS]: 60 });
const CACHE_SETTINGS_SCHEMA = { [CACHE_KEYS.TTL_SECONDS]: { type: 'integer', min: 1, max: 86400 } };

/** TTL vigente da empresa, em segundos (valor ausente ou inválido cai no padrão). Import tardio: settings.service importa este arquivo. */
async function readCacheTtlSeconds(ctx, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(CACHE_KEYS.TTL_SECONDS, { companyId: ctx.companyId, groupId: ctx.groupId }, transaction, CACHE_DEFAULTS[CACHE_KEYS.TTL_SECONDS]);
  return Number.isInteger(value) && value >= 1 ? value : CACHE_DEFAULTS[CACHE_KEYS.TTL_SECONDS];
}

module.exports = { CACHE_KEYS, CACHE_DEFAULTS, CACHE_SETTINGS_SCHEMA, readCacheTtlSeconds };
