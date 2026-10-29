'use strict';

/**
 * M9-D680 — KPI tec.integration_errors (Integrações com erro), versão 1. Posição na janela configurada (padrão a última hora): por fornecedor, chamadas, erros e % de erro = erros ÷
 * chamadas × 100 (2 casas, uma vez), e o número de fornecedores acima do limiar de erro do SLO do Bloco B (erro > 100 - sucesso mínimo da criticidade). O valor é o % de erro de todas as
 * chamadas; chamadas zero -> INCOMPLETE e sem valor. Exemplo: portais, 200 chamadas e 24 erros => 12,00%. Os 9 valores de saúde (sucesso, latência p95 e p99, limite de taxa, falhas de
 * autenticação, tentativas, DLQ, fila e cota) de cada fornecedor, ambiente e família vão em `details.byProvider` para o detalhe (M9-D690) e, um por dimensão `quadro:<fornecedor>~<ambiente>~<família>:<medida>`, para o quadro do painel (M9-D682).
 * Entrada (rm_tech_integrations): { rows: [{ provider, family, environment, calls, errors, successRate, latencyP95Ms, latencyP99Ms, rateLimitCount, authFailures, retries, dlq, backlog,
 * quotaRemaining, errorLimitPct }] } ou, na reconciliação (M9-D611), as linhas de integration.provider_health do filtro ({ calls_total, calls_failed }).
 */
const money = require('./money');
const { incomplete, sumCounts, byText } = require('./_legalCorKpi');
const { safe } = require('./_aiKpi');

const fromSource = (list) => list.map((r) => ({ provider: r.provider_code || '-', calls: r.calls_total, errors: r.calls_failed, errorLimitPct: '100' }));
const nullable = (v) => (v === null || v === undefined ? null : String(v));

// M9-D682: o quadro do painel Segurança/Integrações/IA (Integrações §17) — os 9 valores de saúde de cada fornecedor, ambiente e família. Valor nulo (a conexão não informou) não vira dimensão.
const BOARD = Object.freeze([
  ['successRate', 'sucesso_pct'], ['latencyP95Ms', 'latencia_p95_ms'], ['latencyP99Ms', 'latencia_p99_ms'], ['rateLimitCount', 'limite_taxa_qtd'], ['authFailures', 'falhas_auth_qtd'],
  ['retries', 'tentativas_qtd'], ['dlq', 'dlq_qtd'], ['backlog', 'fila_qtd'], ['quotaRemaining', 'cota_qtd'],
]);

function boardDimensions(byProvider) {
  const out = [];
  for (const line of byProvider) {
    const id = [line.provider, line.environment || '-', line.family || '-'].map((part) => safe(part).replace(/~/g, '_')).join('~');
    for (const [field, suffix] of BOARD) if (line[field] !== null && line[field] !== undefined) out.push({ key: `quadro:${id}:${suffix}`, value: line[field] });
  }
  return out;
}

function providerLine(provider, own) {
  const calls = sumCounts(own.map((r) => r.calls));
  const errors = sumCounts(own.map((r) => r.errors));
  const limit = own.reduce((acc, r) => (acc === null || money.cmp(r.errorLimitPct, acc) < 0 ? String(r.errorLimitPct) : acc), null);
  const hasCalls = money.cmp(calls, 0) > 0;
  return { provider, calls, errors, errorPct: hasCalls ? money.percent(errors, calls).value : null, errorLimitPct: limit, above: hasCalls && money.cmp(money.mul(errors, 100), money.mul(limit, calls)) > 0 };
}

function compute(input) {
  const rows = Array.isArray(input) ? fromSource(input) : input.rows || [];
  const calls = sumCounts(rows.map((r) => r.calls));
  const errors = sumCounts(rows.map((r) => r.errors));
  if (money.cmp(calls, 0) === 0) return incomplete('SEM_CHAMADAS', { calls: '0' });
  const providers = [...new Set(rows.map((r) => r.provider))].sort(byText).map((p) => providerLine(p, rows.filter((r) => r.provider === p)));
  const above = providers.filter((p) => p.above).length;
  const dimensions = [{ key: 'acima_do_slo_qtd', value: String(above) }];
  for (const p of providers) {
    dimensions.push({ key: `provider:${p.provider}:chamadas_qtd`, value: p.calls }, { key: `provider:${p.provider}:erros_qtd`, value: p.errors });
    if (p.errorPct !== null) dimensions.push({ key: `provider:${p.provider}:erro_pct`, value: p.errorPct });
  }
  const byProvider = [...rows].sort((a, b) => byText(`${a.provider}|${a.environment}|${a.family}`, `${b.provider}|${b.environment}|${b.family}`)).map((r) => ({
    provider: r.provider, family: r.family || null, environment: r.environment || null, calls: money.count(r.calls), errors: money.count(r.errors), successRate: nullable(r.successRate),
    latencyP95Ms: nullable(r.latencyP95Ms), latencyP99Ms: nullable(r.latencyP99Ms), rateLimitCount: nullable(r.rateLimitCount), authFailures: nullable(r.authFailures), retries: nullable(r.retries),
    dlq: nullable(r.dlq), backlog: nullable(r.backlog), quotaRemaining: nullable(r.quotaRemaining),
  }));
  dimensions.push(...boardDimensions(byProvider));
  return { value: money.percent(errors, calls).value, status: 'OK', details: { calls, errors, providersAboveLimit: String(above), providers, byProvider }, dimensions };
}

const row = (provider, calls, errors, limit, extra = {}) => ({ provider, family: 'PORTAL', environment: 'PRODUCTION', calls, errors, errorLimitPct: limit, ...extra });
const line = (provider, calls, errors, errorPct, limit, above) => ({ provider, calls, errors, errorPct, errorLimitPct: limit, above });
const health = (provider, calls, errors, extra = {}) => ({
  provider, family: 'PORTAL', environment: 'PRODUCTION', calls, errors, successRate: null, latencyP95Ms: null, latencyP99Ms: null, rateLimitCount: null, authFailures: null, retries: null, dlq: null, backlog: null, quotaRemaining: null, ...extra,
});

const testCases = [
  { kind: 'empty', name: 'sem chamadas na janela: INCOMPLETE e sem valor', input: { rows: [] }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_CHAMADAS', calls: '0' }, dimensions: [] } },
  {
    kind: 'single', name: 'um fornecedor sem erro: 0,00%', input: { rows: [row('portal-sandbox', 10, 0, '1')] },
    expected: {
      value: '0.00', status: 'OK', details: { calls: '10', errors: '0', providersAboveLimit: '0', providers: [line('portal-sandbox', '10', '0', '0.00', '1', false)], byProvider: [health('portal-sandbox', '10', '0')] },
      dimensions: [{ key: 'acima_do_slo_qtd', value: '0' }, { key: 'provider:portal-sandbox:chamadas_qtd', value: '10' }, { key: 'provider:portal-sandbox:erros_qtd', value: '0' }, { key: 'provider:portal-sandbox:erro_pct', value: '0.00' }],
    },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: portais, 200 chamadas e 24 erros => 12,00% (acima do limite de 1%)', input: { rows: [row('portal-sandbox', 200, 24, '1', { successRate: '88.00', latencyP95Ms: 300, quotaRemaining: 50 })] },
    expected: {
      value: '12.00', status: 'OK',
      details: {
        calls: '200', errors: '24', providersAboveLimit: '1', providers: [line('portal-sandbox', '200', '24', '12.00', '1', true)],
        byProvider: [health('portal-sandbox', '200', '24', { successRate: '88.00', latencyP95Ms: '300', quotaRemaining: '50' })],
      },
      dimensions: [{ key: 'acima_do_slo_qtd', value: '1' }, { key: 'provider:portal-sandbox:chamadas_qtd', value: '200' }, { key: 'provider:portal-sandbox:erros_qtd', value: '24' }, { key: 'provider:portal-sandbox:erro_pct', value: '12.00' },
        { key: 'quadro:portal-sandbox~PRODUCTION~PORTAL:sucesso_pct', value: '88.00' }, { key: 'quadro:portal-sandbox~PRODUCTION~PORTAL:latencia_p95_ms', value: '300' }, { key: 'quadro:portal-sandbox~PRODUCTION~PORTAL:cota_qtd', value: '50' }],
    },
  },
  {
    kind: 'typical', name: 'quadro do painel: os 9 valores de saúde por fornecedor, ambiente e família (dois ambientes do mesmo fornecedor)',
    input: {
      rows: [
        { provider: 'wa-main', family: 'MESSAGING', environment: 'PRODUCTION', calls: 100, errors: 2, errorLimitPct: '1', successRate: '98.00', latencyP95Ms: 410, latencyP99Ms: 900, rateLimitCount: 3, authFailures: 1, retries: 7, dlq: 2, backlog: 11, quotaRemaining: 5000 },
        { provider: 'wa-main', family: 'MESSAGING', environment: 'SANDBOX', calls: 10, errors: 0, errorLimitPct: '1', successRate: '100.00', latencyP95Ms: 120, latencyP99Ms: 150, rateLimitCount: 0, authFailures: 0, retries: 0, dlq: 0, backlog: 0, quotaRemaining: null },
      ],
    },
    expected: {
      value: '1.82', status: 'OK',
      details: {
        calls: '110', errors: '2', providersAboveLimit: '1', providers: [line('wa-main', '110', '2', '1.82', '1', true)],
        byProvider: [
          { provider: 'wa-main', family: 'MESSAGING', environment: 'PRODUCTION', calls: '100', errors: '2', successRate: '98.00', latencyP95Ms: '410', latencyP99Ms: '900', rateLimitCount: '3', authFailures: '1', retries: '7', dlq: '2', backlog: '11', quotaRemaining: '5000' },
          { provider: 'wa-main', family: 'MESSAGING', environment: 'SANDBOX', calls: '10', errors: '0', successRate: '100.00', latencyP95Ms: '120', latencyP99Ms: '150', rateLimitCount: '0', authFailures: '0', retries: '0', dlq: '0', backlog: '0', quotaRemaining: null },
        ],
      },
      dimensions: [
        { key: 'acima_do_slo_qtd', value: '1' }, { key: 'provider:wa-main:chamadas_qtd', value: '110' }, { key: 'provider:wa-main:erros_qtd', value: '2' }, { key: 'provider:wa-main:erro_pct', value: '1.82' },
        ...[['PRODUCTION', ['98.00', '410', '900', '3', '1', '7', '2', '11', '5000']], ['SANDBOX', ['100.00', '120', '150', '0', '0', '0', '0', '0']]].flatMap(([env, values]) => (
          ['sucesso_pct', 'latencia_p95_ms', 'latencia_p99_ms', 'limite_taxa_qtd', 'falhas_auth_qtd', 'tentativas_qtd', 'dlq_qtd', 'fila_qtd', 'cota_qtd'].slice(0, values.length).map((m, i) => ({ key: `quadro:wa-main~${env}~MESSAGING:${m}`, value: values[i] }))
        )),
      ],
    },
  },
  {
    kind: 'period_edge', name: 'fornecedor sem chamadas na janela fica fora da taxa e da contagem acima do limite; o limite exato não é acima', input: { rows: [row('a', 100, 1, '1'), row('b', 0, 0, '1')] },
    expected: {
      value: '1.00', status: 'OK',
      details: { calls: '100', errors: '1', providersAboveLimit: '0', providers: [line('a', '100', '1', '1.00', '1', false), line('b', '0', '0', null, '1', false)], byProvider: [health('a', '100', '1'), health('b', '0', '0')] },
      dimensions: [
        { key: 'acima_do_slo_qtd', value: '0' }, { key: 'provider:a:chamadas_qtd', value: '100' }, { key: 'provider:a:erros_qtd', value: '1' }, { key: 'provider:a:erro_pct', value: '1.00' },
        { key: 'provider:b:chamadas_qtd', value: '0' }, { key: 'provider:b:erros_qtd', value: '0' },
      ],
    },
  },
  {
    kind: 'period_edge', name: 'reconciliação com as linhas de provider_health: refaz o percentual', input: [{ provider_code: 'a', calls_total: '150', calls_failed: '15' }, { provider_code: 'a', calls_total: '50', calls_failed: '5' }],
    expected: {
      value: '10.00', status: 'OK',
      details: {
        calls: '200', errors: '20', providersAboveLimit: '0', providers: [line('a', '200', '20', '10.00', '100', false)],
        byProvider: [{ ...health('a', '150', '15'), family: null, environment: null }, { ...health('a', '50', '5'), family: null, environment: null }],
      },
      dimensions: [{ key: 'acima_do_slo_qtd', value: '0' }, { key: 'provider:a:chamadas_qtd', value: '200' }, { key: 'provider:a:erros_qtd', value: '20' }, { key: 'provider:a:erro_pct', value: '10.00' }],
    },
  },
  {
    kind: 'rounding', name: 'fornecedor a: 1 erro em 3 chamadas = 33,33% (arredondado uma vez); no total 2 erros em 5 chamadas = 40,00%', input: { rows: [row('a', 1, 0, '5'), row('b', 2, 1, '5'), { ...row('c', 0, 0, '5') }, row('a', 2, 1, '5')] },
    expected: {
      value: '40.00', status: 'OK',
      details: {
        calls: '5', errors: '2', providersAboveLimit: '2', providers: [line('a', '3', '1', '33.33', '5', true), line('b', '2', '1', '50.00', '5', true), line('c', '0', '0', null, '5', false)],
        byProvider: [health('a', '1', '0'), health('a', '2', '1'), health('b', '2', '1'), health('c', '0', '0')],
      },
      dimensions: [
        { key: 'acima_do_slo_qtd', value: '2' }, { key: 'provider:a:chamadas_qtd', value: '3' }, { key: 'provider:a:erros_qtd', value: '1' }, { key: 'provider:a:erro_pct', value: '33.33' },
        { key: 'provider:b:chamadas_qtd', value: '2' }, { key: 'provider:b:erros_qtd', value: '1' }, { key: 'provider:b:erro_pct', value: '50.00' }, { key: 'provider:c:chamadas_qtd', value: '0' }, { key: 'provider:c:erros_qtd', value: '0' },
      ],
    },
  },
];

module.exports = { id: 'tec.integration_errors', version: 1, compute, testCases };
