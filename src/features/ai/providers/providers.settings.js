'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Parâmetros dos providers da NAY (M9-D011), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv.
 *  - ia.provedor.padrao: código do provedor usado quando ninguém escolhe outro (padrão `ai-sandbox`, PRONTO PARA LAB);
 *  - ia.provedor.safety_tier_minimo_critico: piso de safetyTier (1 a 3) do modelo para agente CRITICAL;
 *  - ia.ambiente: LAB ou PRODUCAO. Em PRODUCAO o provedor de testes é recusado para usuário final. Ir a PRODUCAO exige o portão de
 *    liberação completo (M9-D046, releaseGates/releaseGates.guard.js: 409 AI_PRODUCTION_GATE_INCOMPLETE);
 *  - ia.empresa.lab: a empresa está marcada como laboratório (M9-D046). Em LAB o provedor real só roda em empresa com este parâmetro Ligado.
 */
const PROVIDER_KEYS = Object.freeze({
  defaultProvider: 'ia.provedor.padrao',
  criticalMinSafetyTier: 'ia.provedor.safety_tier_minimo_critico',
  environment: 'ia.ambiente',
  labCompany: 'ia.empresa.lab',
});

const PROVIDER_SETTING_DEFAULTS = Object.freeze({
  [PROVIDER_KEYS.defaultProvider]: 'ai-sandbox',
  [PROVIDER_KEYS.criticalMinSafetyTier]: 2,
  [PROVIDER_KEYS.environment]: 'LAB',
  [PROVIDER_KEYS.labCompany]: false,
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
  [PROVIDER_KEYS.labCompany]: { type: 'boolean' },
};

module.exports = { PROVIDER_KEYS, PROVIDER_SETTING_DEFAULTS, PROVIDER_SETTINGS_SCHEMA };
