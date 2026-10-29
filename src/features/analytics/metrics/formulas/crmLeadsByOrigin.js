'use strict';

/**
 * M9-D630 — KPI crm.leads_by_origin (Leads por origem), versão 1. Lead = oportunidade criada no período (mês de São Paulo da data-base, do dia 1 até
 * a data-base, pela data de criação em São Paulo). Origem vazia vira NAO_INFORMADA. O total é sempre a soma das origens e o percentual de cada origem
 * é contagem / total x 100 (2 casas, uma vez). Entrada (soma do rm_crm_lead_daily no período): { rows: [{ origin, brokerId, leads }] }.
 * Parâmetro: maxNoOriginPct. Regra de qualidade: leads sem origem acima do limite -> DEGRADED, valor nulo (a divisão por origem não é confiável).
 */
const money = require('./money');
const { degraded, originKey, exceedsPct, groupSum, byValueDesc, NO_ORIGIN } = require('./_crmKpi');

function compute(input, params = {}) {
  const maxNoOriginPct = Number.isInteger(params.maxNoOriginPct) ? params.maxNoOriginPct : 5;
  const rows = input.rows || [];
  const byOrigin = groupSum(rows, (r) => originKey(r.origin), (r) => r.leads);
  const byBroker = groupSum(rows, (r) => r.brokerId, (r) => r.leads);
  const total = money.count(money.sum([...byOrigin.values()]));
  const noOrigin = byOrigin.get(NO_ORIGIN) || '0';
  const origins = byValueDesc(byOrigin).map(([origin, count]) => ({ origin, count: money.count(count), percent: money.percent(count, total).value }));
  const dimensions = [];
  for (const o of origins) {
    dimensions.push({ key: `origem:${o.origin}`, value: o.count });
    if (o.percent !== null) dimensions.push({ key: `origem:${o.origin}:parte_pct`, value: o.percent });
  }
  for (const [broker, count] of [...byBroker.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) dimensions.push({ key: `corretor:${broker}`, value: money.count(count) });
  const details = { total, byOrigin: origins, withoutOrigin: money.count(noOrigin), withoutOriginPct: money.percent(noOrigin, total).value };
  if (money.cmp(total, 0) > 0 && exceedsPct(noOrigin, total, maxNoOriginPct)) return degraded('ORIGEM_VAZIA_ACIMA_DO_LIMITE', { ...details, maxNoOriginPct: String(maxNoOriginPct) }, dimensions);
  return { value: total, status: 'OK', details, dimensions };
}

const row = (origin, leads, brokerId = 'b1') => ({ origin, brokerId, leads });
const okOf = (total, origins, noOrigin, noOriginPct, dims) => ({ value: total, status: 'OK', details: { total, byOrigin: origins, withoutOrigin: noOrigin, withoutOriginPct: noOriginPct }, dimensions: dims });
const o = (origin, count, percent) => ({ origin, count, percent });

const testCases = [
  { kind: 'empty', name: 'nenhum lead no período: total 0 e sem origens', input: { rows: [] }, expected: okOf('0', [], '0', null, []) },
  {
    kind: 'single', name: 'um lead de uma origem: 100,00%', input: { rows: [row('SITE', 1)] },
    expected: okOf('1', [o('SITE', '1', '100.00')], '0', '0.00', [{ key: 'origem:SITE', value: '1' }, { key: 'origem:SITE:parte_pct', value: '100.00' }, { key: 'corretor:b1', value: '1' }]),
  },
  {
    kind: 'typical', name: 'exemplo da demanda: portal 48, site 30, indicação 42 => total 120; portal 40,00%',
    input: { rows: [row('PORTAL', 48, 'b1'), row('SITE', 30, 'b2'), row('INDICACAO', 42, 'b1')] },
    expected: okOf('120', [o('PORTAL', '48', '40.00'), o('INDICACAO', '42', '35.00'), o('SITE', '30', '25.00')], '0', '0.00', [
      { key: 'origem:PORTAL', value: '48' }, { key: 'origem:PORTAL:parte_pct', value: '40.00' }, { key: 'origem:INDICACAO', value: '42' }, { key: 'origem:INDICACAO:parte_pct', value: '35.00' },
      { key: 'origem:SITE', value: '30' }, { key: 'origem:SITE:parte_pct', value: '25.00' }, { key: 'corretor:b1', value: '90' }, { key: 'corretor:b2', value: '30' },
    ]),
  },
  {
    kind: 'period_edge', name: 'leads sem origem acima de 5%: DEGRADED, sem valor, com a contagem verdadeira nos detalhes', input: { rows: [row('SITE', 90), row('', 10)] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: {
        reason: 'ORIGEM_VAZIA_ACIMA_DO_LIMITE', total: '100', byOrigin: [o('SITE', '90', '90.00'), o('NAO_INFORMADA', '10', '10.00')], withoutOrigin: '10', withoutOriginPct: '10.00', maxNoOriginPct: '5',
      },
      dimensions: [{ key: 'origem:SITE', value: '90' }, { key: 'origem:SITE:parte_pct', value: '90.00' }, { key: 'origem:NAO_INFORMADA', value: '10' }, { key: 'origem:NAO_INFORMADA:parte_pct', value: '10.00' }, { key: 'corretor:b1', value: '100' }],
    },
  },
  {
    kind: 'rounding', name: 'três origens iguais: 33,33% cada (meio para cima, 2 casas, uma vez); "Site" e "SITE" são a mesma origem',
    input: { rows: [row('Site', 1), row('SITE', 0), row('PORTAL', 1), row('FEIRA', 1)] },
    expected: okOf('3', [o('FEIRA', '1', '33.33'), o('PORTAL', '1', '33.33'), o('SITE', '1', '33.33')], '0', '0.00', [
      { key: 'origem:FEIRA', value: '1' }, { key: 'origem:FEIRA:parte_pct', value: '33.33' }, { key: 'origem:PORTAL', value: '1' }, { key: 'origem:PORTAL:parte_pct', value: '33.33' },
      { key: 'origem:SITE', value: '1' }, { key: 'origem:SITE:parte_pct', value: '33.33' }, { key: 'corretor:b1', value: '3' },
    ]),
  },
  {
    kind: 'rounding', name: 'o limite é configurável: 10 de 100 sem origem passa com limite de 10%', params: { maxNoOriginPct: 10 }, input: { rows: [row('SITE', 90), row('', 10)] },
    expected: okOf('100', [o('SITE', '90', '90.00'), o('NAO_INFORMADA', '10', '10.00')], '10', '10.00', [
      { key: 'origem:SITE', value: '90' }, { key: 'origem:SITE:parte_pct', value: '90.00' }, { key: 'origem:NAO_INFORMADA', value: '10' }, { key: 'origem:NAO_INFORMADA:parte_pct', value: '10.00' }, { key: 'corretor:b1', value: '100' },
    ]),
  },
];

module.exports = { id: 'crm.leads_by_origin', version: 1, compute, testCases };
