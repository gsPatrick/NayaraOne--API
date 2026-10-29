'use strict';

// Apoio da M9-D611: as 11 famílias de KPI (enum domain da M9-D600), cada uma com a unidade, o modo de reconciliação esperado, as linhas de
// origem e o valor do KPI calculado DIRETO das linhas de teste (caminho independente do motor de sourceRefs).
const money = require('../../../src/features/analytics/metrics/formulas/money');

const avg = (key) => (rows) => money.round(money.div(money.sum(rows.map((r) => r[key])), rows.length), 2);
const pct = (rows) => money.round(money.mul(money.div(rows.filter((r) => r.flag).length, rows.length), 100), 2);
const sumAmount = (rows) => money.money(money.sum(rows.map((r) => r.amount)));
const countRows = (rows) => String(rows.length);
const cash = (rows) => money.money(money.sum(rows.map((r) => (r.nature === 'PAYABLE' ? money.sub(0, r.amount) : r.amount))));

// compute das fórmulas do catálogo de teste: recebem as linhas lidas da origem (colunas como texto) e refazem o KPI.
const avgRows = (key) => (rows) => ({ value: money.round(money.div(money.sum(rows.map((r) => r[key])), rows.length), 2) });
const pctRows = (rows) => ({ value: money.round(money.mul(money.div(rows.filter((r) => r.flag === 'true').length, rows.length), 100), 2) });

const FAMILIES = [
  { key: 'fin', domain: 'FINANCE', code: 'fin.m9d611_caixa_livre', unit: 'BRL', mode: 'SUM', expected: cash, valueSign: { column: 'nature', negative: ['PAYABLE'] }, nature: ['RECEIVABLE', 'PAYABLE'], amounts: ['100.10', '250.25', '30.00', '70.40', '12.34'] },
  { key: 'crm', domain: 'CRM', code: 'crm.first_response_time_m9d611', unit: 'MINUTES', mode: 'RECOMPUTE', expected: avg('metric_a'), formula: avgRows('metric_a'), metricA: ['10', '25', '7', '12', '31'] },
  { key: 'prop', domain: 'PROPERTIES', code: 'prop.m9d611_valor_carteira', unit: 'BRL', mode: 'SUM', expected: sumAmount, amounts: ['1500000.00', '980000.50', '450000.25'] },
  { key: 'rent', domain: 'RENTAL', code: 'rent.m9d611_ocupacao', unit: 'PERCENT', mode: 'RECOMPUTE', expected: pct, formula: pctRows, flags: [true, true, false, true, false, true, true] },
  { key: 'obra', domain: 'CONSTRUCTION', code: 'obra.m9d611_desvio_avanco', unit: 'PP', mode: 'RECOMPUTE', expected: avg('metric_a'), formula: avgRows('metric_a'), metricA: ['-3.5', '2', '-8.25', '0.5'] },
  { key: 'inv', domain: 'INVENTORY', code: 'inv.m9d611_valor_estoque', unit: 'BRL', mode: 'SUM', expected: sumAmount, amounts: ['10.10', '20.20', '30.30', '0.05'] },
  { key: 'legal', domain: 'LEGAL', code: 'legal.m9d611_prazos_vencidos', unit: 'COUNT', mode: 'COUNT', expected: countRows, amounts: ['0', '0', '0', '0'] },
  { key: 'cor', domain: 'CORRESPONDENT', code: 'cor.analysis_time_m9d611', unit: 'DAYS', mode: 'RECOMPUTE', expected: avg('metric_a'), formula: avgRows('metric_a'), metricA: ['3', '5', '8', '4'] },
  { key: 'mkt', domain: 'MARKETING', code: 'mkt.m9d611_taxa_abertura', unit: 'PERCENT', mode: 'RECOMPUTE', expected: pct, formula: pctRows, flags: [true, false, false, true, true, false] },
  { key: 'sup', domain: 'SUPPORT', code: 'sup.m9d611_chamados_abertos', unit: 'COUNT', mode: 'COUNT', expected: countRows, amounts: ['0', '0', '0'] },
  { key: 'tec', domain: 'TECH_AI', code: 'tec.availability_m9d611', unit: 'PERCENT', mode: 'RECOMPUTE', expected: pct, formula: pctRows, flags: [true, true, true, true, false] },
];

const PERIOD = Object.freeze({ from: '2026-10-01T03:00:00.000Z', to: '2026-11-01T03:00:00.000Z' });

/** Linhas que entram no KPI (status OK, na empresa e no período) mais ruído que o filtro tem de deixar de fora. */
function rowsFor(family, tenantA, tenantB) {
  const n = Math.max((family.amounts || family.metricA || family.flags).length, 1);
  const inside = [];
  for (let i = 0; i < n; i += 1) {
    inside.push({
      company_id: tenantA.companyId, status: 'OK', nature: family.nature ? family.nature[i % family.nature.length] : 'N',
      occurred_at: `2026-10-${String(5 + i).padStart(2, '0')}T15:00:00Z`, amount: (family.amounts || [])[i] || '0',
      metric_a: (family.metricA || [])[i] || '0', flag: family.flags ? family.flags[i] : false,
    });
  }
  const noise = [
    { ...inside[0], company_id: tenantB.companyId },
    { ...inside[0], status: 'CANCELADO' },
    { ...inside[0], occurred_at: '2026-09-30T15:00:00Z' },
    { ...inside[0], occurred_at: '2026-11-01T03:00:00Z' },
  ];
  return { inside, noise };
}

module.exports = { FAMILIES, PERIOD, rowsFor };
