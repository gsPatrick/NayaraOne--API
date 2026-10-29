'use strict';

/**
 * Parâmetros do cache seguro (M9-D015), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv. Desligado por padrão (conservador: o livro
 * diz "quando aplicável").
 *  - ia.cache.habilitado: liga o cache de respostas não sensíveis (além da lista `cacheableTaskTypes` de cada versão de agente);
 *  - ia.cache.ttl_segundos: por quanto tempo uma resposta guardada vale.
 */
const CACHE_KEYS = Object.freeze({ enabled: 'ia.cache.habilitado', ttlSeconds: 'ia.cache.ttl_segundos' });

const CACHE_SETTING_DEFAULTS = Object.freeze({
  [CACHE_KEYS.enabled]: false,
  [CACHE_KEYS.ttlSeconds]: 900,
});

const CACHE_SETTINGS_SCHEMA = {
  [CACHE_KEYS.enabled]: { type: 'boolean' },
  [CACHE_KEYS.ttlSeconds]: { type: 'integer', min: 1, max: 604800 },
};

module.exports = { CACHE_KEYS, CACHE_SETTING_DEFAULTS, CACHE_SETTINGS_SCHEMA };
