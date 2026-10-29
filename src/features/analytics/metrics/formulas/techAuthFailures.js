'use strict';

/**
 * M9-D680 — KPI tec.auth_failures (Falhas de autenticação), versão 1. Posição no dia-base de São Paulo: falhas de login, de MFA e de autenticação de integração (credencial expirada
 * ou revogada). O valor é o total de falhas; por tipo e por fornecedor vão as falhas e os atores distintos (usuários por hash, nunca identificáveis aqui: IP e usuário só no detalhe
 * com analytics:read:tech). Pico acima do limiar `peakPerHour` (padrão 20 por hora) entra em `details.peaks` e liga `details.alert`. Exemplo: login 31, MFA 4, integração 2.
 * Entrada (rm_tech_auth_failures): { rows: [{ kind, provider, failures, distinctActors, peakHourFailures }], hasLog }. Regra de qualidade: log de autenticação ausente -> INCOMPLETE e sem valor.
 */
const money = require('./money');
const { incomplete, sumCounts, byText } = require('./_legalCorKpi');

const DEFAULT_PEAK_PER_HOUR = 20;
const KINDS = ['LOGIN', 'MFA', 'INTEGRATION'];

function compute(input, params = {}) {
  const rows = input.rows || [];
  if (!input.hasLog) return incomplete('LOG_DE_AUTENTICACAO_AUSENTE', {});
  const limit = Number.isInteger(params.peakPerHour) ? params.peakPerHour : DEFAULT_PEAK_PER_HOUR;
  const total = sumCounts(rows.map((r) => r.failures));
  const dimensions = [];
  const byKind = KINDS.map((kind) => {
    const own = rows.filter((r) => r.kind === kind);
    return { kind, failures: sumCounts(own.map((r) => r.failures)), distinctActors: sumCounts(own.map((r) => r.distinctActors)) };
  });
  for (const k of byKind) dimensions.push({ key: `tipo:${k.kind}:falhas_qtd`, value: k.failures }, { key: `tipo:${k.kind}:atores_distintos_qtd`, value: k.distinctActors });
  for (const provider of [...new Set(rows.filter((r) => r.kind === 'INTEGRATION').map((r) => r.provider))].sort(byText)) {
    dimensions.push({ key: `provider:${provider}:falhas_qtd`, value: sumCounts(rows.filter((r) => r.kind === 'INTEGRATION' && r.provider === provider).map((r) => r.failures)) });
  }
  const peaks = rows.filter((r) => money.cmp(r.peakHourFailures || 0, limit) > 0).map((r) => ({ kind: r.kind, provider: r.provider, peakHourFailures: money.count(r.peakHourFailures) }))
    .sort((a, b) => money.cmp(b.peakHourFailures, a.peakHourFailures) || byText(`${a.kind}${a.provider}`, `${b.kind}${b.provider}`));
  const peak = rows.reduce((acc, r) => (money.cmp(r.peakHourFailures || 0, acc) > 0 ? money.count(r.peakHourFailures) : acc), '0');
  dimensions.push({ key: 'pico_hora_max', value: peak });
  return { value: total, status: 'OK', details: { failures: total, byKind, peakPerHour: String(limit), peaks, alert: peaks.length > 0 }, dimensions };
}

const row = (kind, provider, failures, distinctActors, peakHourFailures) => ({ kind, provider, failures, distinctActors, peakHourFailures });
const kinds = (login, mfa, integration) => [
  { kind: 'LOGIN', failures: login[0], distinctActors: login[1] }, { kind: 'MFA', failures: mfa[0], distinctActors: mfa[1] }, { kind: 'INTEGRATION', failures: integration[0], distinctActors: integration[1] },
];
const dims = (login, mfa, integration, providers, peak) => [
  { key: 'tipo:LOGIN:falhas_qtd', value: login[0] }, { key: 'tipo:LOGIN:atores_distintos_qtd', value: login[1] }, { key: 'tipo:MFA:falhas_qtd', value: mfa[0] }, { key: 'tipo:MFA:atores_distintos_qtd', value: mfa[1] },
  { key: 'tipo:INTEGRATION:falhas_qtd', value: integration[0] }, { key: 'tipo:INTEGRATION:atores_distintos_qtd', value: integration[1] },
  ...providers.map(([p, n]) => ({ key: `provider:${p}:falhas_qtd`, value: n })), { key: 'pico_hora_max', value: peak },
];

const testCases = [
  { kind: 'empty', name: 'log de autenticação ausente: INCOMPLETE e sem valor', input: { rows: [], hasLog: false }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'LOG_DE_AUTENTICACAO_AUSENTE' }, dimensions: [] } },
  {
    kind: 'single', name: 'log presente e nenhuma falha no dia: zero, não nulo', input: { rows: [], hasLog: true },
    expected: { value: '0', status: 'OK', details: { failures: '0', byKind: kinds(['0', '0'], ['0', '0'], ['0', '0']), peakPerHour: '20', peaks: [], alert: false }, dimensions: dims(['0', '0'], ['0', '0'], ['0', '0'], [], '0') },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: login 31, MFA 4, integração 2', input: { rows: [row('LOGIN', '-', 31, 9, 12), row('MFA', '-', 4, 2, 3), row('INTEGRATION', 'portal-sandbox', 2, 1, 2)], hasLog: true },
    expected: {
      value: '37', status: 'OK', details: { failures: '37', byKind: kinds(['31', '9'], ['4', '2'], ['2', '1']), peakPerHour: '20', peaks: [], alert: false },
      dimensions: dims(['31', '9'], ['4', '2'], ['2', '1'], [['portal-sandbox', '2']], '12'),
    },
  },
  {
    kind: 'period_edge', name: 'pico acima do limiar liga o alerta; exatamente no limiar não liga', input: { rows: [row('LOGIN', '-', 40, 3, 21), row('MFA', '-', 20, 1, 20)], hasLog: true },
    expected: {
      value: '60', status: 'OK', details: { failures: '60', byKind: kinds(['40', '3'], ['20', '1'], ['0', '0']), peakPerHour: '20', peaks: [{ kind: 'LOGIN', provider: '-', peakHourFailures: '21' }], alert: true },
      dimensions: dims(['40', '3'], ['20', '1'], ['0', '0'], [], '21'),
    },
  },
  {
    kind: 'period_edge', name: 'o limiar é parâmetro (5 por hora)', input: { rows: [row('MFA', '-', 6, 1, 6)], hasLog: true }, params: { peakPerHour: 5 },
    expected: {
      value: '6', status: 'OK', details: { failures: '6', byKind: kinds(['0', '0'], ['6', '1'], ['0', '0']), peakPerHour: '5', peaks: [{ kind: 'MFA', provider: '-', peakHourFailures: '6' }], alert: true },
      dimensions: dims(['0', '0'], ['6', '1'], ['0', '0'], [], '6'),
    },
  },
  {
    kind: 'rounding', name: 'contagens grandes somam exatas (sem ponto flutuante)', input: { rows: [row('LOGIN', '-', '9007199254740993', 1, 1), row('INTEGRATION', 'a', 1, 1, 1)], hasLog: true },
    expected: {
      value: '9007199254740994', status: 'OK', details: { failures: '9007199254740994', byKind: kinds(['9007199254740993', '1'], ['0', '0'], ['1', '1']), peakPerHour: '20', peaks: [], alert: false },
      dimensions: dims(['9007199254740993', '1'], ['0', '0'], ['1', '1'], [['a', '1']], '1'),
    },
  },
];

module.exports = { id: 'tec.auth_failures', version: 1, compute, testCases };
