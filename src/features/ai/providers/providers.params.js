'use strict';

const { getSetting } = require('../../settings/settings.service');
const { PROVIDER_KEYS: K, PROVIDER_SETTING_DEFAULTS: D } = require('./providers.settings');

/** Parâmetros efetivos da empresa (chamar com a transação do tenant). Valor inválido volta ao padrão. */
async function readProviderParams(ctx, transaction) {
  const [padrao, tier, ambiente] = await Promise.all([
    getSetting(K.defaultProvider, ctx, transaction, D[K.defaultProvider]),
    getSetting(K.criticalMinSafetyTier, ctx, transaction, D[K.criticalMinSafetyTier]),
    getSetting(K.environment, ctx, transaction, D[K.environment]),
  ]);
  return {
    defaultProvider: typeof padrao === 'string' && padrao.trim() ? padrao.trim() : D[K.defaultProvider],
    criticalMinSafetyTier: [1, 2, 3].includes(Number(tier)) ? Number(tier) : D[K.criticalMinSafetyTier],
    production: ambiente === 'PRODUCAO',
  };
}

module.exports = { readProviderParams };
