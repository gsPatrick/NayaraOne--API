'use strict';

/**
 * M9-D680 — KPI tec.freshness (Freshness dos dados do BI), versão 1. Posição: por read model, a idade em minutos da última fonte lida (source_snapshot_at) e o estado FRESH, STALE
 * ou EXPIRED (M9-D609, calculados na leitura com o limite do domínio). O valor é quantos read models estão STALE ou EXPIRED; o pior (maior idade entre eles) vai em `details.worst`.
 * Exemplo: 2 STALE, pior: finance 180 min. Entrada (rm_tech_freshness): { rows: [{ readModel, ageMinutes, state }] }. Regra de qualidade: nenhum registro de atualização -> INCOMPLETE e sem valor.
 */
const money = require('./money');
const { incomplete, byText } = require('./_legalCorKpi');

const LATE = ['STALE', 'EXPIRED'];

function compute(input) {
  const rows = input.rows || [];
  if (!rows.length) return incomplete('SEM_REGISTRO_DE_ATUALIZACAO', {});
  const late = rows.filter((r) => LATE.includes(r.state));
  const stale = late.filter((r) => r.state === 'STALE').length;
  const expired = late.length - stale;
  const worst = late.reduce((acc, r) => (acc === null || money.cmp(r.ageMinutes, acc.ageMinutes) > 0 ? r : acc), null);
  const dimensions = [{ key: 'stale_qtd', value: String(stale) }, { key: 'expirado_qtd', value: String(expired) }];
  if (worst) dimensions.push({ key: 'pior_idade_min', value: money.count(worst.ageMinutes) });
  for (const r of [...rows].sort((a, b) => byText(a.readModel, b.readModel))) dimensions.push({ key: `rm:${r.readModel}:idade_min`, value: money.count(r.ageMinutes) });
  const list = late.sort((a, b) => money.cmp(b.ageMinutes, a.ageMinutes) || byText(a.readModel, b.readModel)).map((r) => ({ readModel: r.readModel, state: r.state, ageMinutes: money.count(r.ageMinutes) }));
  return {
    value: String(late.length), status: 'OK',
    details: { total: String(rows.length), stale: String(stale), expired: String(expired), worst: worst ? { readModel: worst.readModel, state: worst.state, ageMinutes: money.count(worst.ageMinutes) } : null, late: list },
    dimensions,
  };
}

const row = (readModel, ageMinutes, state) => ({ readModel, ageMinutes, state });

const testCases = [
  { kind: 'empty', name: 'nenhum registro de atualização: INCOMPLETE e sem valor', input: { rows: [] }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_REGISTRO_DE_ATUALIZACAO' }, dimensions: [] } },
  {
    kind: 'single', name: 'um read model em dia: zero atrasados e sem pior', input: { rows: [row('rm_finance_health', 5, 'FRESH')] },
    expected: { value: '0', status: 'OK', details: { total: '1', stale: '0', expired: '0', worst: null, late: [] }, dimensions: [{ key: 'stale_qtd', value: '0' }, { key: 'expirado_qtd', value: '0' }, { key: 'rm:rm_finance_health:idade_min', value: '5' }] },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 2 atrasados, pior finance com 180 min', input: { rows: [row('rm_finance_health', 180, 'STALE'), row('rm_crm_outcome', 70, 'STALE'), row('rm_legal_values', 10, 'FRESH')] },
    expected: {
      value: '2', status: 'OK',
      details: {
        total: '3', stale: '2', expired: '0', worst: { readModel: 'rm_finance_health', state: 'STALE', ageMinutes: '180' },
        late: [{ readModel: 'rm_finance_health', state: 'STALE', ageMinutes: '180' }, { readModel: 'rm_crm_outcome', state: 'STALE', ageMinutes: '70' }],
      },
      dimensions: [
        { key: 'stale_qtd', value: '2' }, { key: 'expirado_qtd', value: '0' }, { key: 'pior_idade_min', value: '180' }, { key: 'rm:rm_crm_outcome:idade_min', value: '70' },
        { key: 'rm:rm_finance_health:idade_min', value: '180' }, { key: 'rm:rm_legal_values:idade_min', value: '10' },
      ],
    },
  },
  {
    kind: 'period_edge', name: 'expirado conta como atrasado e vira o pior; idade igual desempata pelo nome', input: { rows: [row('b', 500, 'EXPIRED'), row('a', 500, 'EXPIRED'), row('c', 20, 'STALE')] },
    expected: {
      value: '3', status: 'OK',
      details: {
        total: '3', stale: '1', expired: '2', worst: { readModel: 'b', state: 'EXPIRED', ageMinutes: '500' },
        late: [{ readModel: 'a', state: 'EXPIRED', ageMinutes: '500' }, { readModel: 'b', state: 'EXPIRED', ageMinutes: '500' }, { readModel: 'c', state: 'STALE', ageMinutes: '20' }],
      },
      dimensions: [
        { key: 'stale_qtd', value: '1' }, { key: 'expirado_qtd', value: '2' }, { key: 'pior_idade_min', value: '500' },
        { key: 'rm:a:idade_min', value: '500' }, { key: 'rm:b:idade_min', value: '500' }, { key: 'rm:c:idade_min', value: '20' },
      ],
    },
  },
  {
    kind: 'rounding', name: 'idades e contagens grandes ficam exatas (sem ponto flutuante)', input: { rows: [row('a', '9007199254740993', 'EXPIRED')] },
    expected: {
      value: '1', status: 'OK',
      details: { total: '1', stale: '0', expired: '1', worst: { readModel: 'a', state: 'EXPIRED', ageMinutes: '9007199254740993' }, late: [{ readModel: 'a', state: 'EXPIRED', ageMinutes: '9007199254740993' }] },
      dimensions: [{ key: 'stale_qtd', value: '0' }, { key: 'expirado_qtd', value: '1' }, { key: 'pior_idade_min', value: '9007199254740993' }, { key: 'rm:a:idade_min', value: '9007199254740993' }],
    },
  },
];

module.exports = { id: 'tec.freshness', version: 1, compute, testCases };
