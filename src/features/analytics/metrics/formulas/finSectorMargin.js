'use strict';

/**
 * M9-D623 — KPI fin.sector_margin (Margem por setor), versão 1. Para cada centro de resultado: receita = Σ entradas próprias liquidadas com a
 * competência do mês da data-base; custo = Σ saídas próprias liquidadas da mesma competência; margem = receita − custo; margem % = margem ÷ receita
 * × 100 (2 casas). Valor do indicador = margem total da empresa no mês, em reais; cada setor sai em dimensões (`setor:<id>:receita_brl`,
 * `custo_brl`, `margem_brl`, `margem_pct`). Lançamento sem centro de resultado vai para o setor `sem_setor`.
 * Entrada: { asOfDate, competenceMonth, sectors: [{ id, revenue, cost }] } (somas já feitas no banco, texto decimal). Parâmetro: maxNoSectorPct
 * (analytics.qualidade.max_sem_setor_pct, padrão 1). Qualidade: parte do movimento sem setor acima do limite -> DEGRADED e valor nulo; receita total
 * zero -> INCOMPLETE com o valor da margem exibido (percentual nulo). Dinheiro em decimal exato, arredondado uma só vez (M9-D605).
 */
const money = require('./money');
const { degraded, INCOMPLETE_MESSAGE } = require('./_finKpi');

const NO_SECTOR = 'sem_setor';

function sectorOf(s) {
  const margin = money.sub(s.revenue, s.cost);
  const pct = money.percent(margin, s.revenue);
  return { id: s.id, revenue: money.money(s.revenue), cost: money.money(s.cost), margin: money.money(margin), marginPct: pct.status === 'OK' ? pct.value : null };
}

function dimensionsOf(sectors, totals, noSectorPct) {
  const out = [];
  for (const s of sectors) {
    out.push({ key: `setor:${s.id}:receita_brl`, value: s.revenue }, { key: `setor:${s.id}:custo_brl`, value: s.cost }, { key: `setor:${s.id}:margem_brl`, value: s.margin });
    if (s.marginPct !== null) out.push({ key: `setor:${s.id}:margem_pct`, value: s.marginPct });
  }
  out.push({ key: 'receita_brl', value: totals.revenue }, { key: 'custo_brl', value: totals.cost });
  if (totals.marginPct !== null) out.push({ key: 'margem_pct', value: totals.marginPct });
  out.push({ key: 'sem_setor_pct', value: noSectorPct });
  return out;
}

function compute(input, params = {}) {
  const maxNoSectorPct = String(params.maxNoSectorPct === undefined ? 1 : params.maxNoSectorPct);
  const sectors = [...(input.sectors || [])].sort((a, b) => (a.id < b.id ? -1 : 1)).map(sectorOf);
  const revenue = money.sum(sectors.map((s) => s.revenue));
  const cost = money.sum(sectors.map((s) => s.cost));
  const pct = money.percent(money.sub(revenue, cost), revenue);
  const totals = { revenue: money.money(revenue), cost: money.money(cost), margin: money.money(money.sub(revenue, cost)), marginPct: pct.status === 'OK' ? pct.value : null };
  const unassigned = sectors.find((s) => s.id === NO_SECTOR);
  const moved = money.add(revenue, cost);
  const noSectorPct = unassigned && !money.isZero(moved) ? money.percent(money.add(unassigned.revenue, unassigned.cost), moved).value : '0.00';
  const dimensions = dimensionsOf(sectors, totals, noSectorPct);
  const details = { competenceMonth: input.competenceMonth, totals, noSectorPct, maxNoSectorPct, sectors };
  if (money.cmp(noSectorPct, maxNoSectorPct) > 0) return degraded('LANCAMENTO_SEM_SETOR_ACIMA_DO_LIMITE', { noSectorPct, maxNoSectorPct }, dimensions);
  if (sectors.length && money.isZero(revenue)) return { value: totals.margin, status: 'INCOMPLETE', message: INCOMPLETE_MESSAGE, details, dimensions };
  return { value: totals.margin, status: 'OK', details, dimensions };
}

const L = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const input = (sectors, extra = {}) => ({ asOfDate: '2026-10-28', competenceMonth: '2026-10', sectors, ...extra });
const sector = (id, revenue, cost, margin, marginPct) => ({ id, revenue, cost, margin, marginPct });
const okOf = (value, competenceMonth, sectors, totals, noSectorPct, dimensions) => ({
  value, status: 'OK', details: { competenceMonth, totals, noSectorPct, maxNoSectorPct: '1', sectors }, dimensions,
});
const dims = (id, s) => [{ key: `setor:${id}:receita_brl`, value: s[0] }, { key: `setor:${id}:custo_brl`, value: s[1] }, { key: `setor:${id}:margem_brl`, value: s[2] }, { key: `setor:${id}:margem_pct`, value: s[3] }];

const locacao = sector(L, '80000.00', '52000.00', '28000.00', '35.00');
const vendas = sector(V, '100000.00', '61500.00', '38500.00', '38.50');

const testCases = [
  {
    kind: 'empty', name: 'sem lançamento no mês: margem zero, sem setor e sem percentual', input: input([]), params: { maxNoSectorPct: 1 },
    expected: okOf('0.00', '2026-10', [], { revenue: '0.00', cost: '0.00', margin: '0.00', marginPct: null }, '0.00', [{ key: 'receita_brl', value: '0.00' }, { key: 'custo_brl', value: '0.00' }, { key: 'sem_setor_pct', value: '0.00' }]),
  },
  {
    kind: 'single', name: 'exemplo do livro: Locação com receita 80.000,00 e custo 52.000,00 dá margem 28.000,00 e 35,00%', input: input([{ id: L, revenue: '80000.00', cost: '52000.00' }]),
    expected: okOf('28000.00', '2026-10', [locacao], { revenue: '80000.00', cost: '52000.00', margin: '28000.00', marginPct: '35.00' }, '0.00',
      [...dims(L, ['80000.00', '52000.00', '28000.00', '35.00']), { key: 'receita_brl', value: '80000.00' }, { key: 'custo_brl', value: '52000.00' }, { key: 'margem_pct', value: '35.00' }, { key: 'sem_setor_pct', value: '0.00' }]),
  },
  {
    kind: 'typical', name: 'dois setores: Locação 35,00% e Vendas 38,50%, margem total 66.500,00 (36,94%)', input: input([{ id: V, revenue: '100000.00', cost: '61500.00' }, { id: L, revenue: '80000.00', cost: '52000.00' }]),
    expected: okOf('66500.00', '2026-10', [locacao, vendas], { revenue: '180000.00', cost: '113500.00', margin: '66500.00', marginPct: '36.94' }, '0.00',
      [...dims(L, ['80000.00', '52000.00', '28000.00', '35.00']), ...dims(V, ['100000.00', '61500.00', '38500.00', '38.50']),
        { key: 'receita_brl', value: '180000.00' }, { key: 'custo_brl', value: '113500.00' }, { key: 'margem_pct', value: '36.94' }, { key: 'sem_setor_pct', value: '0.00' }]),
  },
  {
    kind: 'period_edge', name: 'virada de ano: setor sem centro de resultado acima do limite deixa DEGRADED e sem valor', input: input([{ id: L, revenue: '80000.00', cost: '52000.00' }, { id: NO_SECTOR, revenue: '1000.00', cost: '2000.00' }], { asOfDate: '2027-01-01', competenceMonth: '2026-12' }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'LANCAMENTO_SEM_SETOR_ACIMA_DO_LIMITE', noSectorPct: '2.22', maxNoSectorPct: '1' },
      dimensions: [...dims(L, ['80000.00', '52000.00', '28000.00', '35.00']), { key: 'setor:sem_setor:receita_brl', value: '1000.00' }, { key: 'setor:sem_setor:custo_brl', value: '2000.00' }, { key: 'setor:sem_setor:margem_brl', value: '-1000.00' }, { key: 'setor:sem_setor:margem_pct', value: '-100.00' },
        { key: 'receita_brl', value: '81000.00' }, { key: 'custo_brl', value: '54000.00' }, { key: 'margem_pct', value: '33.33' }, { key: 'sem_setor_pct', value: '2.22' }],
    },
  },
  {
    kind: 'rounding', name: 'percentual com meio centésimo arredonda para cima uma só vez (66,67 de 200,00 = 33,34%)', input: input([{ id: V, revenue: '200.00', cost: '133.33' }]),
    expected: okOf('66.67', '2026-10', [sector(V, '200.00', '133.33', '66.67', '33.34')], { revenue: '200.00', cost: '133.33', margin: '66.67', marginPct: '33.34' }, '0.00',
      [...dims(V, ['200.00', '133.33', '66.67', '33.34']), { key: 'receita_brl', value: '200.00' }, { key: 'custo_brl', value: '133.33' }, { key: 'margem_pct', value: '33.34' }, { key: 'sem_setor_pct', value: '0.00' }]),
  },
];

module.exports = { id: 'fin.sector_margin', version: 1, compute, testCases };
