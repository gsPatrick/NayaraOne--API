'use strict';

// Marco 9, M9-D206 — regras puras de saúde do fornecedor (sem banco): agregação, percentis e status.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateSamples } = require('../../../src/features/integrations/health/aggregateSamples');
const { percentile } = require('../../../src/features/integrations/health/percentile');
const { computeHealthStatus } = require('../../../src/features/integrations/health/healthStatus');
const { parseSlo, DEFAULT_SLO } = require('../../../src/features/integrations/health/sloParse');

const AGORA = new Date('2026-10-28T12:00:00Z');
const ha = (s) => new Date(AGORA.getTime() - s * 1000);
const PARAMS = { staleAfterS: 180, downAfterFailures: 3 };
const SLO_HIGH = { minSuccessRate: 99.5, p95Ms: 5000 };

test('health_agregacao_taxa_sucesso: 100 chamadas e 96 sucessos dão 96,00', () => {
  const calls = Array.from({ length: 100 }, (_, i) => ({ ok: i >= 4, latencyMs: 100 }));
  const m = aggregateSamples({ calls, rateLimitCount: 2, authFailures: 1, retriesTotal: 7, dlqCount: 3, backlogCount: 5 });
  assert.equal(m.callsTotal, 100);
  assert.equal(m.callsSuccess, 96);
  assert.equal(m.callsFailed, 4);
  assert.equal(m.successRate, 96);
  assert.equal(m.rateLimitCount, 2);
  assert.equal(m.authFailures, 1);
  assert.equal(m.retriesTotal, 7);
  assert.equal(m.dlqCount, 3);
  assert.equal(m.backlogCount, 5);
  // sem chamadas não há taxa (nem 100 nem 0), e os percentis ficam vazios
  const vazio = aggregateSamples({ calls: [] });
  assert.equal(vazio.callsTotal, 0);
  assert.equal(vazio.successRate, null);
  assert.equal(vazio.latencyP95Ms, null);
  // duas casas decimais, arredondando
  const um = aggregateSamples({ calls: [{ ok: true, latencyMs: 1 }, { ok: true, latencyMs: 1 }, { ok: false, latencyMs: 1 }] });
  assert.equal(um.successRate, 66.67);
});

test('health_percentis_interpolacao_linear: 100..1000 ms em 10 chamadas dão p50=550, p95=955 e p99=991', () => {
  const calls = Array.from({ length: 10 }, (_, i) => ({ ok: true, latencyMs: (i + 1) * 100 })).reverse();
  const m = aggregateSamples({ calls });
  assert.equal(m.latencyP50Ms, 550);
  assert.equal(m.latencyP95Ms, 955);
  assert.equal(m.latencyP99Ms, 991);
  assert.equal(percentile([42], 99), 42);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20], 100), 20);
});

test('health_status_regras: HEALTHY, DEGRADED, DOWN e UNKNOWN', () => {
  const base = { circuitState: 'CLOSED', successRate: 99.9, latencyP95Ms: 800, checkConsecutiveFailures: 0, lastDataAt: ha(10), now: AGORA };
  const status = (over, slo = SLO_HIGH, params = PARAMS) => computeHealthStatus({ ...base, ...over }, params, slo);
  assert.equal(status({}), 'HEALTHY');
  assert.equal(status({ successRate: null, latencyP95Ms: null }), 'HEALTHY', 'sem chamadas, circuito fechado e dado fresco');
  // exemplo do livro: 96% com limiar 99,5 (HIGH)
  assert.equal(status({ successRate: 96 }), 'DEGRADED');
  assert.equal(status({ successRate: 99.5 }), 'HEALTHY', 'no limiar exato ainda é saudável');
  assert.equal(status({ latencyP95Ms: 5001 }), 'DEGRADED', 'p95 acima do SLO');
  assert.equal(status({ latencyP95Ms: 5000 }), 'HEALTHY');
  assert.equal(status({ circuitState: 'HALF_OPEN' }), 'DEGRADED');
  assert.equal(status({ circuitState: 'OPEN' }), 'DOWN');
  assert.equal(status({ circuitState: 'OPEN', lastDataAt: ha(900) }), 'DOWN', 'circuito aberto é fato persistido, mesmo sem dado novo');
  assert.equal(status({ checkConsecutiveFailures: 2 }), 'HEALTHY');
  assert.equal(status({ checkConsecutiveFailures: 3 }), 'DOWN');
  assert.equal(status({}, SLO_HIGH, { ...PARAMS, downAfterFailures: 2, }), 'HEALTHY');
  assert.equal(status({ checkConsecutiveFailures: 2 }, SLO_HIGH, { ...PARAMS, downAfterFailures: 2 }), 'DOWN', 'o limite vem do parâmetro');
  // dado velho: "sem registro há 200 s" com limite de 180 s
  assert.equal(status({ lastDataAt: ha(200) }), 'UNKNOWN');
  assert.equal(status({ lastDataAt: ha(180) }), 'HEALTHY', 'exatamente no limite ainda vale');
  assert.equal(status({ lastDataAt: null }), 'UNKNOWN');
  assert.equal(status({ lastDataAt: ha(100) }, SLO_HIGH, { ...PARAMS, staleAfterS: 60 }), 'UNKNOWN', 'o limite vem do parâmetro');
});

test('health_slo_texto_do_parametro: lê sucesso, p95, p99 e backlog do texto configurável', () => {
  assert.deepEqual(parseSlo('99.5% / p95 5 s / p99 12 s / backlog 15 min'), { minSuccessRate: 99.5, p95Ms: 5000, p99Ms: 12000, backlogMin: 15 });
  assert.deepEqual(parseSlo('95.0% / p95 15 s / p99 40 s / backlog 24 h'), { minSuccessRate: 95, p95Ms: 15000, p99Ms: 40000, backlogMin: 1440 });
  assert.equal(parseSlo('qualquer coisa'), null);
  assert.equal(parseSlo('99.5% / p95 5 s'), null);
  assert.deepEqual(Object.keys(DEFAULT_SLO).sort(), ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']);
  assert.equal(DEFAULT_SLO.CRITICAL.minSuccessRate, 99.9);
  assert.equal(DEFAULT_SLO.MEDIUM.p95Ms, 8000);
});
