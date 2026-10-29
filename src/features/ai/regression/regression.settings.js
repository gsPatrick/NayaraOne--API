'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Parâmetros da regressão por troca (M9-D033), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv.
 *  - ia.provedor.modelo_padrao: modelo usado com o provedor padrão da empresa (`auto` = o primeiro modelo de geração do provedor);
 *    junto do provedor padrão, entra no `global_hash` e a troca exige avaliação aprovada para o novo par;
 *  - ia.golden.exigir_dataset_cadastrado: desligado, o golden do agente é o dataset cadastrado mais os casos de base da engenharia;
 *    ligado, só vale o dataset cadastrado (ai.golden_cases), com ao menos um caso por categoria aplicável;
 *  - ia.golden.max_casos_por_agente: teto de casos ativos por agente na empresa.
 */
const AUTO_MODEL = 'auto';

const REGRESSION_KEYS = Object.freeze({
  defaultModel: 'ia.provedor.modelo_padrao',
  requireRegisteredDataset: 'ia.golden.exigir_dataset_cadastrado',
  maxCasesPerAgent: 'ia.golden.max_casos_por_agente',
});

const REGRESSION_SETTING_DEFAULTS = Object.freeze({
  [REGRESSION_KEYS.defaultModel]: AUTO_MODEL,
  [REGRESSION_KEYS.requireRegisteredDataset]: false,
  [REGRESSION_KEYS.maxCasesPerAgent]: 500,
});

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

const REGRESSION_SETTINGS_SCHEMA = {
  [REGRESSION_KEYS.defaultModel]: {
    type: 'string',
    validate: (key, value) => {
      if (!MODEL_RE.test(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ser o código de um modelo ou auto.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  [REGRESSION_KEYS.requireRegisteredDataset]: { type: 'boolean' },
  [REGRESSION_KEYS.maxCasesPerAgent]: { type: 'integer', min: 10, max: 5000 },
};

module.exports = { AUTO_MODEL, REGRESSION_KEYS, REGRESSION_SETTING_DEFAULTS, REGRESSION_SETTINGS_SCHEMA };
