'use strict';

// M9-D699 — critérios de aprovação em função pura dos números (exemplos da demanda), parâmetro do administrador e relatório que aponta o responsável.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, variationPct } = require('../../../scripts/analytics/load/verdict');
const { renderText } = require('../../../scripts/analytics/load/report');
const { percentile, summarize } = require('../../../scripts/analytics/load/stats');
const { LOAD_DEFAULTS, KEY } = require('../../../src/features/analytics/loadTest.settings');
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
