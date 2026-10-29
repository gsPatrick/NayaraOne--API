'use strict';

/**
 * Parâmetros da avaliação da NAY (M9-D031 e M9-D032), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. Os limiares dos pisos de segurança (hallucination, permissions, injection = 100%) são do
 * livro e não variam.
 */
const EVALUATION_KEYS = Object.freeze({
  groundingMin: 'ia.avaliacao.grounding_min',
  toolSelectionMin: 'ia.avaliacao.tool_selection_min',
  costMaxPerCase: 'ia.avaliacao.custo_max_por_caso',
  humanForAll: 'ia.avaliacao.homologacao_humana_todos',
  allowRealProvider: 'ia.avaliacao.permitir_provider_real',
});

const EVALUATION_SETTING_DEFAULTS = Object.freeze({
  [EVALUATION_KEYS.groundingMin]: 100,
  [EVALUATION_KEYS.toolSelectionMin]: 95,
  [EVALUATION_KEYS.costMaxPerCase]: 0.05,
  [EVALUATION_KEYS.humanForAll]: true,
  [EVALUATION_KEYS.allowRealProvider]: false,
});

const EVALUATION_SETTINGS_SCHEMA = {
  [EVALUATION_KEYS.groundingMin]: { type: 'integer', min: 0, max: 100 },
  [EVALUATION_KEYS.toolSelectionMin]: { type: 'integer', min: 0, max: 100 },
  [EVALUATION_KEYS.costMaxPerCase]: { type: 'number', min: 0, max: 1000 },
  [EVALUATION_KEYS.humanForAll]: { type: 'boolean' },
  [EVALUATION_KEYS.allowRealProvider]: { type: 'boolean' },
};

module.exports = { EVALUATION_KEYS, EVALUATION_SETTING_DEFAULTS, EVALUATION_SETTINGS_SCHEMA };
