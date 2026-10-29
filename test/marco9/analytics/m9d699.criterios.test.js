'use strict';

// M9-D699 — critérios de aprovação em função pura dos números (exemplos da demanda), parâmetro do administrador e relatório que aponta o responsável.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, variationPct } = require('../../../scripts/analytics/load/verdict');
const { renderText } = require('../../../scripts/analytics/load/report');
const { percentile, summarize } = require('../../../scripts/analytics/load/stats');
const { LOAD_DEFAULTS, KEY, FLOOR_KEY } = require('../../../src/features/analytics/loadTest.settings');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const stat = (p95, count = 100, p50 = p95 / 2) => ({ count, errors: 0, p50, p95, p99: p95, max: p95 });
const base = { criar_lancamento: stat(180) };
const rebuildOk = { completed: true, hashBefore: 'h', hashAfter: 'h' };
const run = (withBi, extra = {}) => evaluate({ baseline: base, withBi: { criar_lancamento: stat(withBi) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, ...extra });

test('m9d699 exemplos da demanda: 180 ms -> 192 ms aprova (+6,7%) e 230 ms reprova (+27,8%)', () => {
  const ok = run(192);
  assert.equal(ok.pass, true);
  assert.equal(ok.oltp.criar_lancamento.variationPct, '6.7');
  const bad = run(230);
  assert.equal(bad.pass, false);
  assert.equal(bad.oltp.criar_lancamento.variationPct, '27.8');
  assert.deepEqual(bad.failures.map((f) => [f.kind, f.name]), [['OLTP', 'criar_lancamento']]);
  assert.equal(variationPct(0, 5), null, 'linha de base zero não gera percentual');
});

test('m9d699 o limite é exato: 198 ms (+10,0%) aprova e 198,001 ms reprova', () => {
  assert.equal(run(198).pass, true);
  assert.equal(run(198.001).pass, false);
});

test('m9d699 o limite vem do parâmetro analytics.carga.degradacao_max_pct (padrão 10)', () => {
  assert.equal(KEY, 'analytics.carga.degradacao_max_pct');
  assert.equal(LOAD_DEFAULTS[KEY], 10);
  assert.deepEqual(SETTINGS_SCHEMA[KEY], { type: 'integer', min: 0, max: 1000 });
  assert.equal(run(230, { maxPct: 30 }).pass, true, 'com 30% a mesma medição aprova');
  assert.equal(run(192, { maxPct: 5 }).pass, false, 'com 5% reprova');
});

test('m9d699 painel acima da meta, rebuild sem concluir, hash diferente e falha inesperada reprovam a etapa', () => {
  assert.equal(run(190, { panels: { finance: stat(1600) } }).pass, false);
  assert.equal(run(190, { panels: { finance: stat(1600) } }).failures[0].kind, 'PAINEL');
  assert.equal(run(190, { rebuild: { completed: false, error: 'ANALYTICS_REBUILD_FAILED: x' } }).pass, false);
  assert.equal(run(190, { rebuild: { completed: true, hashBefore: 'a', hashAfter: 'b' } }).pass, false);
  assert.equal(run(190, { unexpected: 2 }).failures[0].kind, 'ERRO');
  assert.equal(run(190, { panels: { finance: stat(900), sem_meta: stat(10) } }).pass, false, 'painel sem meta não passa em branco');
});

test('m9d699 o relatório aponta o painel responsável e traz percentis, erros e veredito', () => {
  const verdict = run(230, { panels: { finance: stat(900, 400), crm: stat(1200, 900, 800) }, targets: { finance: 1500, crm: 1500 } });
  assert.equal(verdict.culprit.panel, 'crm');
  const text = renderText({ verdict });
  assert.match(text, /REPROVADA/);
  assert.match(text, /\[OLTP\] criar_lancamento/);
  assert.match(text, /painel que mais consumiu tempo de servidor: crm/);
});

test('m9d699 percentis pelo posto mais próximo, sem interpolação', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual([percentile(sorted, 50), percentile(sorted, 95), percentile(sorted, 99)], [50, 95, 99]);
  assert.equal(percentile([], 95), null);
  const s = summarize([{ ms: 5, ok: true }, { ms: 9, ok: false }, { ms: 7, ok: true }]);
  assert.deepEqual([s.count, s.errors, s.p95], [3, 1, 7], 'falha entra na contagem de erros e fora dos percentis');
});

test('m9d699 piso absoluto: operação de poucos ms com ruído aprova, degradação real reprova (analytics.carga.tolerancia_absoluta_ms)', () => {
  const small = (withBi, floorMs) => evaluate({ baseline: { criar_lancamento: stat(1.8) }, withBi: { criar_lancamento: stat(withBi) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, floorMs });
  assert.equal(small(2.5, 0).pass, false, 'sem piso, +38,9% de 1,8 ms reprova (o ruído que tornava o teste intermitente)');
  assert.equal(small(2.5, 1).pass, true, 'com piso de 1 ms, +0,7 ms aprova');
  assert.equal(small(2.5, 1).oltp.criar_lancamento.byFloor, true);
  assert.equal(small(2.8, 1).pass, true, 'exatamente no piso (+1,0 ms) aprova');
  assert.equal(small(2.801, 1).pass, false, 'acima do piso e do percentual reprova');
  assert.equal(run(230, { floorMs: 1 }).pass, false, 'o piso não perdoa a degradação do exemplo da demanda (+50 ms)');
  assert.equal(FLOOR_KEY, 'analytics.carga.tolerancia_absoluta_ms');
  assert.equal(LOAD_DEFAULTS[FLOOR_KEY], 2);
  assert.deepEqual(SETTINGS_SCHEMA[FLOOR_KEY], { type: 'number', min: 0, max: 1000 });
});

test('m9d699 mediana das rodadas: uma rodada com ruído aprova, degradação em todas as rodadas reprova', () => {
  const round = (b, w) => ({ baseline: { criar_lancamento: stat(b) }, withBi: { criar_lancamento: stat(w) } });
  const ev = (rounds, floorMs = 0) => evaluate({ baseline: base, withBi: { criar_lancamento: stat(200) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, floorMs, rounds });
  const noisy = ev([round(100, 104), round(100, 180), round(100, 98)]);
  assert.equal(noisy.pass, true, '2 de 3 rodadas dentro do limite: a rodada ruidosa não reprova');
  assert.deepEqual([noisy.oltp.criar_lancamento.roundsPassed, noisy.oltp.criar_lancamento.roundsTotal], [2, 3]);
  const real = ev([round(100, 150), round(100, 160), round(100, 105)]);
  assert.equal(real.pass, false, 'só 1 de 3 rodadas dentro do limite: reprova');
  assert.match(real.failures[0].reason, /1 de 3 rodadas/);
  assert.equal(ev([round(100, 150), round(100, 160)]).pass, false, 'em 2 rodadas as duas precisam passar (mais da metade)');
  assert.equal(ev([round(100, 104), round(100, 110)]).pass, true);
});

test('m9d699 envelope de ruído: BI dentro da oscilação da própria linha de base aprova; acima dela reprova', () => {
  const round = (b, w) => ({ baseline: { criar_lancamento: stat(b) }, withBi: { criar_lancamento: stat(w) } });
  const ev = (pooledBi, rounds) => evaluate({ baseline: { criar_lancamento: stat(100) }, withBi: { criar_lancamento: stat(pooledBi) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, floorMs: 0, rounds });
  const noisyBase = [round(100, 130), round(140, 130), round(100, 130)];
  const ok = ev(130, noisyBase);
  assert.equal(ok.pass, true, 'a linha de base já oscila de 100 a 140 ms sem o BI: 130 ms com BI não se distingue disso');
  assert.equal(ev(150, [round(100, 150), round(140, 150), round(100, 150)]).pass, false, '150 ms passa do maior p95 de rodada sem BI (140 ms)');
  assert.equal(ev(130, [round(100, 130), round(101, 130), round(100, 130)]).pass, false, 'linha de base estável (100 a 101 ms): +30% é degradação real');
});
