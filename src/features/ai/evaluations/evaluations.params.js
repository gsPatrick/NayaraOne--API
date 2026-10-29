'use strict';

const { getSetting } = require('../../settings/settings.service');
const { EVALUATION_KEYS: K, EVALUATION_SETTING_DEFAULTS: D } = require('./evaluations.settings');

const MICROS = 1000000;

/** Valor decimal da configuração (número ou texto com vírgula) em micro-unidades inteiras; inválido volta ao padrão. */
function toMicros(value, fallback) {
  const n = Number(typeof value === 'string' ? value.replace(',', '.') : value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * MICROS) : Math.round(fallback * MICROS);
}

const percent = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100 ? Number(value) : fallback);

/** Parâmetros efetivos da empresa. Chamar com a transação do tenant (RLS). Valor inválido volta ao padrão, nunca a zero. */
async function readEvaluationParams(ctx, transaction) {
  const get = (key) => getSetting(key, ctx, transaction, D[key]);
  const [grounding, tool, cost, humanForAll, realProvider] = await Promise.all([
    get(K.groundingMin), get(K.toolSelectionMin), get(K.costMaxPerCase), get(K.humanForAll), get(K.allowRealProvider),
  ]);
  return {
    groundingMin: percent(grounding, D[K.groundingMin]),
    toolSelectionMin: percent(tool, D[K.toolSelectionMin]),
    costMaxPerCaseMicros: toMicros(cost, D[K.costMaxPerCase]),
    humanForAll: humanForAll !== false,
    allowRealProvider: realProvider === true,
  };
}

module.exports = { readEvaluationParams, toMicros, MICROS };
