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

test('m9d699 o antigo envelope de ruído foi removido: oscilação da linha de base não perdoa +30% com BI', () => {
  const round = (b, w) => ({ baseline: { criar_lancamento: stat(b) }, withBi: { criar_lancamento: stat(w) } });
  const ev = (pooledBi, rounds) => evaluate({ baseline: { criar_lancamento: stat(100) }, withBi: { criar_lancamento: stat(pooledBi) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, floorMs: 0, rounds });
  const r = ev(130, [round(100, 130), round(140, 130), round(100, 130)]);
  assert.equal(r.pass, false, 'só 1 de 3 rodadas (a de base 140) fica dentro do limite: antes o envelope aprovava');
  assert.equal(r.oltp.criar_lancamento.baselineRoundMaxP95, undefined);
  assert.equal(ev(130, [round(100, 130), round(101, 130), round(100, 130)]).pass, false);
});

test('m9d699 prova determinística: bloqueio causado pelo BI reprova, sem amostra do BI ativo a prova não vale, zero bloqueio aprova', () => {
  const probe = (extra = {}) => ({ samples: 120, blockedByBi: 0, biSeen: 90, maxBiActive: 3, intervalMs: 25, ...extra });
  const ev = (locks) => evaluate({ baseline: base, withBi: { criar_lancamento: stat(190) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, locks });
  assert.equal(ev(probe()).pass, true);
  assert.equal(ev(probe()).locks.blockedByBi, 0);
  const blocked = ev(probe({ blockedByBi: 2 }));
  assert.equal(blocked.pass, false);
  assert.deepEqual(blocked.failures.map((f) => f.kind), ['BLOQUEIO']);
  assert.match(blocked.failures[0].reason, /2 amostra\(s\).*lock de uma sessão do BI/);
  assert.equal(ev(probe({ biSeen: 0 })).pass, false, 'a sonda nunca viu o BI: a prova não vale');
  assert.equal(ev(probe({ samples: 0, biSeen: 0 })).pass, false);
  assert.equal(ev(probe({ error: '42501' })).pass, false, 'sonda que falhou não aprova');
  assert.equal(ev(null).locks.skipped, true, 'sem sonda (cálculo puro) o critério não se aplica');
  assert.match(renderText({ verdict: blocked }), /Bloqueios causados pelo BI.*FALHOU/);
});

test('m9d699 latência só vale com a CPU sobrando: saturada fica INCONCLUSIVA (não reprova), no modo estrito reprova, quieta continua estrita', () => {
  const ev = (host, withBi = 230) => evaluate({ baseline: base, withBi: { criar_lancamento: stat(withBi) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, host });
  const quiet = { cpuBusyMax: 0.4, saturationMax: 0.85, strict: false };
  assert.equal(ev(quiet).pass, false, 'CPU sobrando: +27,8% reprova');
  assert.equal(ev(quiet).latency.conclusive, true);
  const busy = { cpuBusyMax: 0.97, saturationMax: 0.85, strict: false };
  const inconclusive = ev(busy);
  assert.equal(inconclusive.pass, true);
  assert.equal(inconclusive.oltp.criar_lancamento.inconclusive, true);
  assert.equal(inconclusive.latency.conclusive, false);
  assert.match(inconclusive.latency.reason, /máquina saturada: CPU ocupada em 97% \(limite 85%\)/);
  assert.match(renderText({ verdict: inconclusive }), /INCONCLUSIV/);
  const strict = ev({ ...busy, strict: true });
  assert.equal(strict.pass, false, 'no pipeline LAB (--exigir-latencia) máquina saturada reprova: a prova não pôde ser feita');
  assert.match(strict.failures[0].reason, /máquina saturada/);
  assert.equal(ev(busy, 190).pass, true, 'dentro do limite aprova mesmo saturada, sem marcar inconclusivo');
  assert.equal(ev(busy, 190).oltp.criar_lancamento.inconclusive, undefined);
  assert.equal(ev(busy).locks.skipped, true);
});

test('m9d699 modo observação: a latência fora do limite é relatada como observada e não reprova; bloqueio do BI e painel sem medida continuam reprovando', () => {
  const ev = (extra = {}) => evaluate({ baseline: base, withBi: { criar_lancamento: stat(230) }, panels: { finance: stat(1900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10, latencyMode: 'report', ...extra });
  const r = ev();
  assert.equal(r.pass, true);
  assert.deepEqual([r.oltp.criar_lancamento.observed, r.panels.finance.observed, r.latency.mode], [true, true, 'report']);
  assert.match(renderText({ verdict: r }), /observado \(fora do limite\)/);
  assert.equal(ev({ locks: { samples: 100, blockedByBi: 1, biSeen: 50, maxBiActive: 2, intervalMs: 25 } }).pass, false, 'bloqueio causado pelo BI reprova mesmo em observação');
  assert.equal(ev({ unexpected: 1 }).pass, false);
  assert.equal(ev({ rebuild: { completed: false, error: 'x' } }).pass, false);
  assert.equal(ev({ panels: { finance: stat(null) } }).pass, false, 'painel sem nenhuma medida reprova (cobertura)');
  assert.equal(evaluate({ baseline: base, withBi: { criar_lancamento: stat(230) }, panels: { finance: stat(900) }, targets: { finance: 1500 }, rebuild: rebuildOk, maxPct: 10 }).pass, false, 'sem o modo observação (padrão do CLI e do LAB) +27,8% reprova');
});
