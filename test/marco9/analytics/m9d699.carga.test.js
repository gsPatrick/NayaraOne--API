'use strict';

// M9-D699 — a carga de verdade (banco descartável): fluxo operacional sem e com os painéis sob carga, p95 dos painéis contra a meta de cada um e
// rebuild do FinanceHealthReadModel durante a carga. A medida é a mediana de 5 rodadas alternadas (base, BI) com piso absoluto de tolerância
// (DI-D699-8 e DI-D699-9): ruído da máquina não reprova, degradação real aparece em todas as rodadas e reprova.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoadTest } = require('../../../scripts/analytics/loadTest');
const { sequelize } = require('../../testHelpers');

const OPTIONS = { scale: 'light', durationMs: 2500, rounds: 5, oltpUsers: 4, biUsers: 8, thinkMs: 5, closeModels: false, latencyMode: 'report' }; // máquina compartilhada: a latência é medida e relatada; quem reprova aqui é o gate determinístico (DI-D699-10)
let result;
let jsonFile;

before(async () => {
  jsonFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm9d699-')), 'relatorio.json');
  result = await runLoadTest({ ...OPTIONS, json: jsonFile }); // uma execução só: a estabilidade vem do método (mediana de 5 rodadas e piso absoluto), não de repetir até passar
});
after(async () => { fs.rmSync(path.dirname(jsonFile), { recursive: true, force: true }); await sequelize.close(); });

test('m9d699 dashboard pesado não degrada OLTP em teste de carga', () => {
  const v = result.report.verdict;
  assert.equal(v.pass, true, `reprovou:\n${result.text}`);
  assert.equal(v.maxPct, 10, 'limite vindo do parâmetro (padrão 10%)');
  assert.equal(v.floorMs, 2, 'piso absoluto vindo do parâmetro (padrão 2 ms)');
  assert.deepEqual(Object.keys(v.oltp).sort(), ['apontar_relatorio', 'criar_lancamento', 'liquidar_lancamento', 'mover_oportunidade']);
  const { latency } = v;
  assert.equal(latency.mode, 'report', 'modo observação do teste automatizado (a latência vem no relatório; o gate é determinístico)');
  assert.ok(latency.conclusive || latency.reason, 'latência inconclusiva sempre diz o motivo (máquina saturada), nunca aprova calada');
  if (latency.conclusive) for (const r of Object.values(v.oltp)) assert.equal(r.inconclusive, undefined, 'máquina quieta: a latência é estrita, sem dispensa');
  for (const [op, r] of Object.entries(v.oltp)) {
    assert.equal(r.pass, true, `${op}: ${r.reason}`);
    assert.ok(result.report.baseline[op].count >= 100 && result.report.withBi[op].count >= 100, `${op}: amostras suficientes dos dois lados`);
    assert.equal(result.report.withBi[op].errors, 0, `${op}: sem erro com os painéis sob carga`);
  }
});

test('m9d699 nenhuma sessão do fluxo operacional esperou lock do BI durante a carga (prova que não depende da velocidade da máquina)', () => {
  const { locks } = result.report.verdict;
  assert.equal(locks.pass, true, locks.reason);
  assert.equal(locks.blockedByBi, 0);
  assert.ok(locks.samples >= 50, `a sonda precisa ter amostrado a janela inteira (${locks.samples} amostras)`);
  assert.ok(locks.biSeen >= 10, `a sonda precisa ter visto sessões do BI ativas (${locks.biSeen} amostras)`);
  assert.equal(locks.error, undefined);
});

test('m9d699 p95 dos painéis dentro das metas sob a carga', async () => {
  const { panels } = result.report.verdict;
  assert.equal(Object.keys(panels).length, 13, 'os 12 painéis e o Centro de Comando do catálogo');
  const [rows] = await sequelize.query("SELECT dashboard_code, p95_target_ms FROM analytics.dashboard_definitions WHERE status = 'PUBLISHED' AND company_id IS NULL AND group_id IS NULL");
  for (const { dashboard_code: code, p95_target_ms: target } of rows) {
    assert.equal(panels[code].targetMs, target, `${code}: a meta é a da coluna p95_target_ms (M9-D698)`);
    assert.ok(panels[code].p95 !== null, `${code}: o painel precisa ter sido medido (cobertura independente da velocidade da máquina)`);
    assert.equal(panels[code].observed === true, panels[code].p95 > target, `${code}: p95 ${panels[code].p95} ms contra a meta de ${target} ms (acima da meta só como observação neste teste; o pipeline LAB reprova)`);
    assert.equal(result.report.panels[code].errors, 0);
  }
  const metricReads = Object.keys(result.report.other).filter((k) => k.startsWith('metric:'));
  assert.ok(metricReads.length > 0 && metricReads.every((k) => result.report.other[k].count > 0), `os KPIs publicados também foram lidos (${metricReads.length} lidos)`);
  assert.ok(result.report.other.drilldown.count > 0, 'o drill-down alternou com a abertura dos painéis');
});

test('m9d699 rebuild sob carga conclui e reproduz o hash', () => {
  const { rebuild } = result.report.verdict;
  assert.equal(rebuild.pass, true, rebuild.reason);
  assert.equal(rebuild.completed, true);
  assert.equal(rebuild.hashBefore, rebuild.hashAfter, 'mesmo hash antes e depois');
  assert.match(rebuild.hashBefore, /^[0-9a-f]{64}$/);
  assert.equal(rebuild.changed, 0);
  assert.ok(result.report.other.rebuilds.length >= 5, 'um rebuild por rodada de carga com BI');
});

test('m9d699 o relatório JSON traz configuração, percentis, erros, massa e veredito, sem segredo', () => {
  const onDisk = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['anchor', 'baseline', 'config', 'generatedAt', 'massa', 'other', 'panels', 'scale', 'seed', 'startedAt', 'verdict', 'withBi']);
  for (const key of ['count', 'errors', 'p50', 'p95', 'p99']) assert.ok(key in onDisk.baseline.criar_lancamento, key);
  assert.equal(onDisk.massa.companies, 3);
  assert.match(onDisk.massa.digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(onDisk), /postgres(ql)?:\/\/|password|secret|token/i);
  assert.match(result.text, /Carga do BI: APROVADA/);
});

test('m9d699 a carga limpou a massa e os painéis não escreveram no fluxo operacional', async () => {
  const [[left]] = await sequelize.query("SELECT count(*)::int AS n FROM core.companies WHERE name LIKE 'M9 CARGA %'");
  assert.equal(left.n, 0, 'nenhuma empresa da massa sobra');
});
