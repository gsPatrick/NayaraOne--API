'use strict';

/**
 * M9-D634 — ordem das linhas de um widget de barras, funil ou tabela. A ordem dos estágios vem dos parâmetros do administrador (funil do CRM:
 * `analytics.comercial.ordem_estagios`; estágios do Correspondente: `analytics.correspondente.estagios_validos`), nunca de uma lista no código.
 * Modos de `config.order`: STAGES_CRM e STAGES_COR (ordem do parâmetro; o que está fora dele vai depois, em ordem alfabética), NUMERIC (pelo número
 * que abre o código, como as faixas 0-30, 31-90) e, sem modo, VALUE_DESC (maior primeiro). O desempate é sempre o código.
 */
const { readStageOrder } = require('../metrics/stageOrder');

const LISTS = Object.freeze({
  STAGES_CRM: (scope, tx) => readStageOrder('CRM', scope, tx),
  STAGES_COR: (scope, tx) => readStageOrder('COR', scope, tx),
});

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lead = (id) => { const m = /^\d+/.exec(id); return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER; };
const first = (item) => (item.value !== null && item.value !== undefined ? item.value : (item.cells || []).map((c) => c.value).find((v) => v !== null && v !== undefined));
/** Faixas de valor: "ate_2000" primeiro, as faixas "2001-5000" pelo número que as abre e "acima_10000" por último (os limites vêm do parâmetro do administrador). */
const bandRank = (id) => (id.startsWith('ate_') ? -1 : id.startsWith('acima_') ? Number.MAX_SAFE_INTEGER : lead(id));
const num = (item) => Number(first(item) === undefined ? 0 : first(item));

/** Lista de códigos do parâmetro para o modo pedido, ou null quando o modo não usa lista. */
async function loadOrderList(mode, scope, transaction) {
  return LISTS[mode] ? LISTS[mode](scope, transaction) : null;
}

/** Ordena as linhas (cada uma com `id` e `value`) conforme o modo; a lista vem de `loadOrderList`. */
function sortItems(items, mode, list) {
  const rows = [...items];
  if (list) {
    const index = new Map(list.map((id, i) => [id, i]));
    const rank = (id) => (index.has(id) ? index.get(id) : list.length);
    return rows.sort((a, b) => rank(a.id) - rank(b.id) || byText(a.id, b.id));
  }
  if (mode === 'ID') return rows.sort((a, b) => byText(a.id, b.id)); // M9-D682: pelo código da linha (sondas, quadro de integrações)
  if (mode === 'BANDS') return rows.sort((a, b) => bandRank(a.id) - bandRank(b.id) || byText(a.id, b.id)); // M9-D643
  if (mode === 'NUMERIC') return rows.sort((a, b) => lead(a.id) - lead(b.id) || byText(a.id, b.id));
  return rows.sort((a, b) => num(b) - num(a) || byText(a.id, b.id));
}

module.exports = { loadOrderList, sortItems };
