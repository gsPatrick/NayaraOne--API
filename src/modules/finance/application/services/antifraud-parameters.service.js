'use strict';

/**
 * Valor em vigor de cada parâmetro numérico do antifraude (DEC-007), para a aba "Financeiro" de Configurações mostrar o que a regra está usando
 * (DI-DEC007-2): o gravado quando é válido, o padrão da DEC-007 quando nada foi gravado ou quando o gravado está fora do tipo ou da faixa. Usa o mesmo
 * leitor único da regra (readFinanceNumberDetail), então a tela nunca mostra um número diferente do que o antifraude aplica. Só leitura.
 */
const { NUMERIC_KEYS, FINANCE_SETTINGS_SCHEMA, readFinanceNumberDetail } = require('./finance-settings');

async function listAntifraudParameters(tenant, transaction) {
  const rows = [];
  for (const key of NUMERIC_KEYS) {
    const detail = await readFinanceNumberDetail(key, tenant, transaction);
    const spec = FINANCE_SETTINGS_SCHEMA[key];
    rows.push({ key, label: spec.label, type: spec.type, min: spec.min, max: spec.max, defaultValue: detail.defaultValue, storedValue: detail.stored, effectiveValue: detail.value, source: detail.source });
  }
  return rows;
}

module.exports = { listAntifraudParameters };
