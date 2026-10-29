'use strict';

/**
 * M9-D680 — KPI tec.availability (Disponibilidade), versão 1. Posição no mês de São Paulo até a data-base: disponibilidade = sondas com sucesso ÷ sondas ESPERADAS no período × 100,
 * arredondada UMA vez para 2 casas (M9-D605; o exemplo do caderno, 43.160 ÷ 43.200 = 99,9074%, dá 99,91; DI-D680-1: a "3 casas" do texto vira `details.availability3`).
 * Sonda ausente (a própria sonda falhou em medir) NÃO conta como sucesso: esperadas menos feitas entra em `details.missingProbes`. Minutos fora do ar = sondas falhas × intervalo.
 * Entrada (rm_tech_availability): { rows: [{ probe, checks, up, expected }], probes: [sondas ligadas] } ou, na reconciliação (M9-D611), as próprias linhas. Parâmetros: intervalS e
 * maxMissingPct. Regra de qualidade: mais de maxMissingPct % de sondas ausentes, ou sonda ligada sem nenhuma medição -> DEGRADED; sem sonda esperada -> INCOMPLETE. Valor nulo nesses casos.
 */
const money = require('./money');
const { degraded, incomplete, exceedsPct, sumCounts, byText } = require('./_legalCorKpi');

const DEFAULT_MAX_MISSING_PCT = 5;
const DEFAULT_INTERVAL_S = 60;

function compute(input, params = {}) {
  const rows = (Array.isArray(input) ? input : input.rows) || [];
  const configured = (!Array.isArray(input) && input.probes) || [];
  const intervalS = Number.isInteger(params.intervalS) ? params.intervalS : DEFAULT_INTERVAL_S;
  const maxMissingPct = Number.isInteger(params.maxMissingPct) ? params.maxMissingPct : DEFAULT_MAX_MISSING_PCT;
  if (!rows.length) return incomplete('SEM_SONDAS', {});
  const probes = [...new Set(rows.map((r) => r.probe))].sort(byText);
  const withoutData = configured.filter((p) => !probes.includes(p)).sort(byText);
  const expected = sumCounts(rows.map((r) => r.expected));
  const checks = sumCounts(rows.map((r) => r.checks));
  const up = sumCounts(rows.map((r) => r.up));
  if (money.cmp(expected, 0) === 0) return incomplete('SEM_SONDAS_ESPERADAS', {});
  const missing = money.count(money.sub(expected, checks));
  if (withoutData.length) return degraded('SONDA_SEM_MEDICAO', { probesWithoutData: withoutData, missingProbes: missing });
  if (exceedsPct(missing, expected, maxMissingPct)) return degraded('SONDAS_AUSENTES', { expected, checks, missingProbes: missing, maxMissingPct: String(maxMissingPct) });
  const failed = money.count(money.sub(checks, up));
  const dimensions = [];
  for (const probe of probes) {
    const own = rows.filter((r) => r.probe === probe);
    const ownExpected = sumCounts(own.map((r) => r.expected));
    dimensions.push(
      { key: `sonda:${probe}:disponibilidade_pct`, value: money.percent(sumCounts(own.map((r) => r.up)), ownExpected).value },
      { key: `sonda:${probe}:ausentes_qtd`, value: money.count(money.sub(ownExpected, sumCounts(own.map((r) => r.checks)))) }
    );
  }
  const minutesDown = money.round(money.div(money.mul(failed, intervalS), 60), 2);
  dimensions.push({ key: 'ausentes_qtd', value: missing }, { key: 'minutos_fora_do_ar', value: minutesDown });
  const availability3 = money.round(money.mul(money.div(up, expected), 100), 3);
  return { value: money.percent(up, expected).value, status: 'OK', details: { expected, checks, up, missingProbes: missing, failedProbes: failed, minutesDown, availability3 }, dimensions };
}

const row = (probe, checks, up, expected) => ({ probe, checks, up, expected });
const bad = (reason, details) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });
const none = (reason) => ({ value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma sonda no mês: INCOMPLETE e sem valor', input: { rows: [], probes: ['API'] }, params: { intervalS: 60 }, expected: none('SEM_SONDAS') },
  {
    kind: 'single', name: 'uma sonda, uma medição com sucesso: 100,00%', input: { rows: [row('API', 1, 1, 1)], probes: ['API'] }, params: { intervalS: 60 },
    expected: {
      value: '100.00', status: 'OK', details: { expected: '1', checks: '1', up: '1', missingProbes: '0', failedProbes: '0', minutesDown: '0.00', availability3: '100.000' },
      dimensions: [{ key: 'sonda:API:disponibilidade_pct', value: '100.00' }, { key: 'sonda:API:ausentes_qtd', value: '0' }, { key: 'ausentes_qtd', value: '0' }, { key: 'minutos_fora_do_ar', value: '0.00' }],
    },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 43.200 sondas, 43.160 ok => 99,91% (40 minutos fora do ar)', input: { rows: [row('API', 43200, 43160, 43200)], probes: ['API'] }, params: { intervalS: 60 },
    expected: {
      value: '99.91', status: 'OK', details: { expected: '43200', checks: '43200', up: '43160', missingProbes: '0', failedProbes: '40', minutesDown: '40.00', availability3: '99.907' },
      dimensions: [{ key: 'sonda:API:disponibilidade_pct', value: '99.91' }, { key: 'sonda:API:ausentes_qtd', value: '0' }, { key: 'ausentes_qtd', value: '0' }, { key: 'minutos_fora_do_ar', value: '40.00' }],
    },
  },
  {
    kind: 'period_edge', name: 'mais de 5% de sondas ausentes: DEGRADED e sem valor', input: { rows: [row('API', 94, 94, 100)], probes: ['API'] }, params: { intervalS: 60, maxMissingPct: 5 },
    expected: bad('SONDAS_AUSENTES', { expected: '100', checks: '94', missingProbes: '6', maxMissingPct: '5' }),
  },
  {
    kind: 'period_edge', name: 'sonda ligada sem nenhuma medição: DEGRADED e sem valor', input: { rows: [row('API', 10, 10, 10)], probes: ['API', 'STORAGE'] }, params: { intervalS: 60 },
    expected: bad('SONDA_SEM_MEDICAO', { probesWithoutData: ['STORAGE'], missingProbes: '0' }),
  },
  {
    kind: 'rounding', name: 'sondas ausentes dentro do limite não contam como sucesso e o meio sobe uma vez (7 de 8 = 87,50%)', input: { rows: [row('API', 8, 7, 8)], probes: ['API'] }, params: { intervalS: 30 },
    expected: {
      value: '87.50', status: 'OK', details: { expected: '8', checks: '8', up: '7', missingProbes: '0', failedProbes: '1', minutesDown: '0.50', availability3: '87.500' },
      dimensions: [{ key: 'sonda:API:disponibilidade_pct', value: '87.50' }, { key: 'sonda:API:ausentes_qtd', value: '0' }, { key: 'ausentes_qtd', value: '0' }, { key: 'minutos_fora_do_ar', value: '0.50' }],
    },
  },
  {
    kind: 'rounding', name: 'duas sondas, uma ausente (4,35%, dentro do limite): 21 de 23 = 91,30% e 91,304 em details; 2 de 3 = 66,67%', input: { rows: [row('API', 19, 19, 20), row('DATABASE', 3, 2, 3)], probes: ['API', 'DATABASE'] }, params: { intervalS: 60, maxMissingPct: 5 },
    expected: {
      value: '91.30', status: 'OK', details: { expected: '23', checks: '22', up: '21', missingProbes: '1', failedProbes: '1', minutesDown: '1.00', availability3: '91.304' },
      dimensions: [
        { key: 'sonda:API:disponibilidade_pct', value: '95.00' }, { key: 'sonda:API:ausentes_qtd', value: '1' }, { key: 'sonda:DATABASE:disponibilidade_pct', value: '66.67' },
        { key: 'sonda:DATABASE:ausentes_qtd', value: '0' }, { key: 'ausentes_qtd', value: '1' }, { key: 'minutos_fora_do_ar', value: '1.00' },
      ],
    },
  },
];

module.exports = { id: 'tec.availability', version: 1, compute, testCases };
