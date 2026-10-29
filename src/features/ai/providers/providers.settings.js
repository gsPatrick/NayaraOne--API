'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Parâmetros dos providers da NAY (M9-D011), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv.
 *  - ia.provedor.padrao: código do provedor usado quando ninguém escolhe outro (padrão `ai-sandbox`, PRONTO PARA LAB);
 *  - ia.provedor.safety_tier_minimo_critico: piso de safetyTier (1 a 3) do modelo para agente CRITICAL;
 *  - ia.ambiente: LAB ou PRODUCAO. Em PRODUCAO o provedor de testes é recusado para usuário final (a liberação é da M9-D046,
 *    que é dona da chave; ela é declarada aqui porque o sandbox precisa lê-la agora).
 */
const PROVIDER_KEYS = Object.freeze({
  defaultProvider: 'ia.provedor.padrao',
  criticalMinSafetyTier: 'ia.provedor.safety_tier_minimo_critico',
  environment: 'ia.ambiente',
});

const PROVIDER_SETTING_DEFAULTS = Object.freeze({
  [PROVIDER_KEYS.defaultProvider]: 'ai-sandbox',
  [PROVIDER_KEYS.criticalMinSafetyTier]: 2,
  [PROVIDER_KEYS.environment]: 'LAB',
});

const CODE_RE = /^[a-z0-9_-]{1,48}$/;

const PROVIDER_SETTINGS_SCHEMA = {
  [PROVIDER_KEYS.defaultProvider]: {
    type: 'string',
    validate: (key, value) => {
      if (!CODE_RE.test(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ser o código de um provedor (letras minúsculas, números, - e _).`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  [PROVIDER_KEYS.criticalMinSafetyTier]: { type: 'integer', min: 1, max: 3 },
  [PROVIDER_KEYS.environment]: { type: 'string', enum: ['LAB', 'PRODUCAO'] },
};

module.exports = { PROVIDER_KEYS, PROVIDER_SETTING_DEFAULTS, PROVIDER_SETTINGS_SCHEMA };
