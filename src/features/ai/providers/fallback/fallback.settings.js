'use strict';

/**
 * Parâmetros do fallback seguro de modelo (M9-D013), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv.
 *  - ia.fallback.max_saltos: quantas trocas de modelo um mesmo run pode fazer depois de uma queda (padrão 2, conservador);
 *  - ia.fallback.exigir_avaliacao_verde: o candidato só serve se tem avaliação aprovada para o agente (regressão ao trocar modelo, livro).
 */
const FALLBACK_KEYS = Object.freeze({
  maxHops: 'ia.fallback.max_saltos',
  requireGreen: 'ia.fallback.exigir_avaliacao_verde',
});

const FALLBACK_SETTING_DEFAULTS = Object.freeze({
  [FALLBACK_KEYS.maxHops]: 2,
  [FALLBACK_KEYS.requireGreen]: true,
});

const FALLBACK_SETTINGS_SCHEMA = {
  [FALLBACK_KEYS.maxHops]: { type: 'integer', min: 1, max: 5, requiresMfa: true }, // parametros.csv exige_mfa_para_alterar = sim (settings/settingMfa.js)
  [FALLBACK_KEYS.requireGreen]: { type: 'boolean' },
};

module.exports = { FALLBACK_KEYS, FALLBACK_SETTING_DEFAULTS, FALLBACK_SETTINGS_SCHEMA };
