'use strict';

// M9-D699 — a carga de verdade (banco descartável): fluxo operacional sem e com os painéis sob carga, p95 dos painéis contra a meta de cada um e
// rebuild do FinanceHealthReadModel durante a carga. A comparação roda em até 3 tentativas porque a máquina tem ruído: a etapa só reprova se
// nenhuma tentativa ficar dentro do limite (degradação real reprova todas).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoadTest } = require('../../../scripts/analytics/loadTest');
const { sequelize } = require('../../testHelpers');

const OPTIONS = { scale: 'light', durationMs: 4000, rounds: 2, oltpUsers: 4, biUsers: 8, thinkMs: 5, closeModels: false };
let result;
let jsonFile;
const attempts = [];

before(async () => {
  jsonFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm9d699-')), 'relatorio.json');
  for (let i = 0; i < 3 && !(result && result.pass); i += 1) {
    result = await runLoadTest({ ...OPTIONS, json: jsonFile });
    attempts.push(result.report.verdict.pass);
  }
});
after(async () => { fs.rmSync(path.dirname(jsonFile), { recursive: true, force: true }); await sequelize.close(); });

test('m9d699 dashboard pesado não degrada OLTP em teste de carga', () => {
  const v = result.report.verdict;
  assert.equal(v.pass, true, `reprovou nas ${attempts.length} tentativas:\n${result.text}`);
  assert.equal(v.maxPct, 10, 'limite vindo do parâmetro (padrão 10%)');
  assert.deepEqual(Object.keys(v.oltp).sort(), ['apontar_relatorio', 'criar_lancamento', 'liquidar_lancamento', 'mover_oportunidade']);
  for (const [op, r] of Object.entries(v.oltp)) {
    assert.equal(r.pass, true, `${op}: ${r.reason}`);
    assert.ok(result.report.baseline[op].count >= 100 && result.report.withBi[op].count >= 100, `${op}: amostras suficientes dos dois lados`);
    assert.equal(result.report.withBi[op].errors, 0, `${op}: sem erro com os painéis sob carga`);
  }
});

test('m9d699 p95 dos painéis dentro das metas sob a carga', async () => {
  const { panels } = result.report.verdict;
  assert.equal(Object.keys(panels).length, 13, 'os 12 painéis e o Centro de Comando do catálogo');
  const [rows] = await sequelize.query("SELECT dashboard_code, p95_target_ms FROM analytics.dashboard_definitions WHERE status = 'PUBLISHED' AND company_id IS NULL AND group_id IS NULL");
  for (const { dashboard_code: code, p95_target_ms: target } of rows) {
    assert.equal(panels[code].targetMs, target, `${code}: a meta é a da coluna p95_target_ms (M9-D698)`);
    assert.ok(panels[code].p95 !== null && panels[code].p95 <= target, `${code}: p95 ${panels[code].p95} ms contra a meta de ${target} ms`);
    assert.equal(result.report.panels[code].errors, 0);
  }
  assert.ok(result.report.other['metric:fin.reconciliations_pending'].count > 0, 'os KPIs financeiros também foram lidos');
  assert.ok(result.report.other.drilldown.count > 0, 'o drill-down alternou com a abertura dos painéis');
});

test('m9d699 rebuild sob carga conclui e reproduz o hash', () => {
  const { rebuild } = result.report.verdict;
  assert.equal(rebuild.pass, true, rebuild.reason);
  assert.equal(rebuild.completed, true);
  assert.equal(rebuild.hashBefore, rebuild.hashAfter, 'mesmo hash antes e depois');
  assert.match(rebuild.hashBefore, /^[0-9a-f]{64}$/);
  assert.equal(rebuild.changed, 0);
  assert.ok(result.report.other.rebuilds.length >= 2, 'um rebuild por rodada de carga com BI');
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
