'use strict';

/**
 * M9-D622 / M9-D640 — peças comuns das fórmulas de inadimplência (Financeiro e Locação): faixas de atraso, soma por faixa e por contrato a partir do detalhe das
 * entradas vencidas do read model, e a taxa refeita sobre as linhas-fonte (reconciliação do detalhe no modo RECOMPUTE, M9-D611). Dinheiro em decimal exato
 * (money.js), arredondado uma só vez. Sem relógio: a data-base entra sempre como parâmetro.
 *
 * Detalhe (read model): { windowDays, total, count, withoutContract: { amount, inWindow }, byContract: { id: { amount, inWindow } },
 * byAge: [{ date, count, amount, lateDays }] }. Dentro da janela = atraso de 1 a windowDays-1 dias (a janela é [hoje - windowDays + 1, hoje - 1]).
 */
const money = require('./money');
const { daysBetween } = require('./_dates');

const DEFAULT_LIMITS = Object.freeze([30, 60, 90]);

/** Rótulos das faixas para os limites [30, 60, 90]: 1-30, 31-60, 61-90 e 90+ (a última é "acima do último limite", como no livro). */
function bandLabels(limits) {
  const edges = Array.isArray(limits) && limits.length ? limits : DEFAULT_LIMITS;
  return [...edges.map((edge, i) => `${i === 0 ? 1 : edges[i - 1] + 1}-${edge}`), `${edges[edges.length - 1]}+`];
}

const bandIndex = (lateDays, limits) => {
  const edges = Array.isArray(limits) && limits.length ? limits : DEFAULT_LIMITS;
  const i = edges.findIndex((edge) => lateDays <= edge);
  return i === -1 ? edges.length : i;
};

/** [{ label, amount, inWindow, count }] na ordem das faixas; cada dia de vencimento entra na faixa dos seus dias de atraso. */
function bandsOf(detail, limits) {
  const labels = bandLabels(limits);
  const bands = labels.map((label) => ({ label, amount: '0', inWindow: '0', count: '0' }));
  const windowDays = Number.isInteger(detail.windowDays) ? detail.windowDays : 90;
  for (const age of detail.byAge || []) {
    const band = bands[bandIndex(age.lateDays, limits)];
    band.amount = money.toString(money.add(band.amount, age.amount));
    band.count = money.count(money.add(band.count, age.count));
    if (age.lateDays <= windowDays - 1) band.inWindow = money.toString(money.add(band.inWindow, age.amount));
  }
  return bands;
}

/** Contratos com o valor vencido e o que cai na janela, em ordem de id; mais a parte sem contrato. */
const contractsOf = (detail) => Object.keys(detail.byContract || {}).sort().map((id) => ({ id, amount: detail.byContract[id].amount, inWindow: detail.byContract[id].inWindow }));

/**
 * Taxa refeita sobre as linhas-fonte do filtro da taxa (entradas próprias da janela, sem estorno nem cancelamento): { rows: [{ status, amount, due_day }] } com
 * params.asOfDate. Vencido = PENDING com vencimento (dia de São Paulo) anterior à data-base; base = todas as linhas. Base zero -> INCOMPLETE e valor nulo.
 */
function rateFromRows(rows, asOfDate) {
  const list = rows || [];
  const overdue = list.filter((r) => r.status === 'PENDING' && daysBetween(String(r.due_day).slice(0, 10), asOfDate) > 0);
  const result = money.percent(money.sum(overdue.map((r) => r.amount)), money.sum(list.map((r) => r.amount)));
  return { value: result.value, status: result.status, details: {}, dimensions: [] };
}

module.exports = { DEFAULT_LIMITS, bandLabels, bandsOf, contractsOf, rateFromRows };
