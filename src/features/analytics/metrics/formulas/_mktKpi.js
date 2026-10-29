'use strict';

/**
 * M9-D670 / M9-D671 — peças comuns das fórmulas dos KPIs de Marketing: a campanha "Sem campanha" (UUID zero do read model), a chave de canal
 * (os canais da campanha unidos por "+", em ordem; "SEM_CANAL" quando não tem nenhum, o que mantém as dimensões por canal somáveis) e o reaproveitamento
 * do resultado sem valor (DEGRADED/INCOMPLETE) das fórmulas do Jurídico e do Correspondente.
 */
const { degraded, incomplete, exceedsPct, sumCounts, byText } = require('./_legalCorKpi');
const money = require('./money');

const NO_CAMPAIGN = '00000000-0000-0000-0000-000000000000';
const NO_CHANNEL = 'SEM_CANAL';

const channelKey = (channels) => {
  const list = [...new Set((channels || []).filter(Boolean))].sort(byText);
  return list.length ? list.join('+') : NO_CHANNEL;
};

/** Soma decimal (texto) com 2 casas de uma lista de valores em reais. */
const sumMoney = (list) => money.round(money.sum(list.map((v) => v || 0)), 2);

/** Agrupa linhas por chave somando campos inteiros; devolve [chave, { campo: texto }] ordenado pela chave. */
function groupSum(rows, keyOf, fields) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const acc = out.get(key) || Object.fromEntries(fields.map((f) => [f, '0']));
    for (const f of fields) acc[f] = money.count(money.add(acc[f], row[f] || 0));
    out.set(key, acc);
  }
  return [...out.entries()].sort((a, b) => byText(a[0], b[0]));
}

/** Percentual com 2 casas ou null quando o denominador é zero. */
const pct = (part, total) => money.percent(part, total).value;

module.exports = { NO_CAMPAIGN, NO_CHANNEL, channelKey, sumMoney, groupSum, pct, degraded, incomplete, exceedsPct, sumCounts, byText };
