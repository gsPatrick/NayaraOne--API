'use strict';

/**
 * Parâmetros da recomendação da NAY (M9-D007), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. `ia.aprovacao.aprovador_distinto` também é lido pela aprovação de ações (M9-D019).
 */
const RECOMMENDATION_KEYS = Object.freeze({
  rationaleMax: 'ia.recomendacao.justificativa_max_caracteres',
  listMax: 'ia.recomendacao.lista_max_itens',
  reasonRequired: 'ia.recomendacao.motivo_rejeicao_obrigatorio',
  distinctApprover: 'ia.aprovacao.aprovador_distinto',
});

const RECOMMENDATION_SETTING_DEFAULTS = Object.freeze({
  [RECOMMENDATION_KEYS.rationaleMax]: 1000,
  [RECOMMENDATION_KEYS.listMax]: 100,
  [RECOMMENDATION_KEYS.reasonRequired]: true,
  [RECOMMENDATION_KEYS.distinctApprover]: true,
});

const RECOMMENDATION_SETTINGS_SCHEMA = {
  [RECOMMENDATION_KEYS.rationaleMax]: { type: 'integer', min: 100, max: 4000 },
  [RECOMMENDATION_KEYS.listMax]: { type: 'integer', min: 1, max: 500 },
  [RECOMMENDATION_KEYS.reasonRequired]: { type: 'boolean' },
  [RECOMMENDATION_KEYS.distinctApprover]: { type: 'boolean' },
};

module.exports = { RECOMMENDATION_KEYS, RECOMMENDATION_SETTING_DEFAULTS, RECOMMENDATION_SETTINGS_SCHEMA };
