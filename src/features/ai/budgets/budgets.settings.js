'use strict';

const AppError = require('../../../utils/AppError');
const { ACTIONS_AT_100 } = require('./budgets.constants');

/**
 * Parâmetros do orçamento (M9-D014), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv.
 * limiares: porcentagens crescentes que geram alerta. acao_ao_100: BLOCK ou DEGRADE para agente não crítico.
 * limiar_degradacao: a partir de quantos % o agente não crítico só usa RULE, CACHE e modelo pequeno (independe dos alertas).
 */
const BUDGET_KEYS = Object.freeze({
  thresholds: 'ia.orcamento.limiares',
  actionAt100: 'ia.orcamento.acao_ao_100',
  degradeFrom: 'ia.orcamento.limiar_degradacao',
});

const BUDGET_SETTING_DEFAULTS = Object.freeze({
  [BUDGET_KEYS.thresholds]: '50,75,90,100',
  [BUDGET_KEYS.actionAt100]: 'BLOCK',
  [BUDGET_KEYS.degradeFrom]: 90,
});

/** "50, 75,90" -> [50,75,90] (inteiros de 1 a 1000, estritamente crescentes, de 1 a 10 itens) ou null. */
function parseThresholds(value) {
  const items = (Array.isArray(value) ? value : String(value ?? '').split(',')).map((x) => (typeof x === 'string' ? x.trim() : x));
  if (items.length < 1 || items.length > 10) return null;
  const numbers = items.map((x) => (typeof x === 'number' ? x : /^\d{1,4}$/.test(x) ? Number(x) : NaN));
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)) return null;
  for (let i = 1; i < numbers.length; i += 1) if (numbers[i] <= numbers[i - 1]) return null;
  return numbers;
}

const BUDGET_SETTINGS_SCHEMA = {
  [BUDGET_KEYS.thresholds]: {
    type: 'string',
    validate: (key, value) => {
      if (!parseThresholds(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser de 1 a 10 porcentagens inteiras crescentes separadas por vírgula (ex.: 50,75,90,100).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  [BUDGET_KEYS.actionAt100]: { type: 'string', enum: [...ACTIONS_AT_100] },
  [BUDGET_KEYS.degradeFrom]: { type: 'integer', min: 1, max: 100 },
};

module.exports = { BUDGET_KEYS, BUDGET_SETTING_DEFAULTS, BUDGET_SETTINGS_SCHEMA, parseThresholds };
