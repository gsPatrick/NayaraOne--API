'use strict';

// M9-D624 — definição dos KPIs no registry, parâmetros do administrador, origem (sourceRefs), cálculo automático no refresh e regras estáticas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env624 = require('../_helpers/m9d624Env');
const registry = require('../../../src/features/analytics/metrics');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const readModels = require('../../../src/features/analytics/read-models');
require('../../../src/features/analytics'); // entrada real do BI: liga os KPIs financeiros ao fim do refresh

const { bankTx, statementImport, anomaly, refresh, kpis, readKpi, dayAt, setSetting } = env624;
const API = path.join(__dirname, '..', '..', '..');
let env;
before(async () => { env = await env624.setup(); });
after(() => env624.teardown(env));

const definition = async (t, code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: t.companyId, code } }))[0][0];

test('m9d624 os dois KPIs existem no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade', async () => {
  const t = env.cX;
  await setSetting(env, t, 'analytics.owner.fin.anomalies_open', 'Controladoria (papel controller)');
  await anomaly(env, t, { risk: 'LOW', createdAt: dayAt(-1) });
  await statementImport(env, t, { account: env624.ledger.uuid(), createdAt: dayAt(-1) });
  await refresh(t);
  await kpis(t);
  const rec = await definition(t, 'fin.reconciliations_pending');
  assert.deepEqual([rec.version, rec.unit, rec.formula_id, rec.source_read_model, rec.domain, rec.status, rec.value_nature], [1, 'COUNT', 'fin.reconciliations_pending', 'rm_finance_health', 'FINANCE', 'PUBLISHED', 'ACTUAL']);
  assert.deepEqual(rec.dimensions, ['empresa', 'conta bancária', 'faixa de idade (0-2, 3-7, 8+)']);
  assert.equal(rec.owner_role, 'Diretoria Financeira (papel financeiro-gestor)', 'owner padrão da demanda');
  assert.equal(rec.refresh_policy.mode, 'EVENT');
  assert.equal(rec.refresh_policy.maxStalenessMinutes, 15);
  assert.ok(rec.quality_rule.referenceReport && rec.quality_rule.requiredFields.includes('last_statement_import_date'));
  const open = await definition(t, 'fin.anomalies_open');
  assert.deepEqual([open.version, open.unit, open.formula_id, open.source_read_model], [1, 'COUNT', 'fin.anomalies_open', 'rm_finance_health']);
  assert.deepEqual(open.dimensions, ['empresa', 'nível de risco', 'tipo de anomalia']);
  assert.equal(open.owner_role, 'Controladoria (papel controller)', 'o owner vem do parâmetro analytics.owner.fin.anomalies_open');
  assert.equal(registry.getFormulaCatalog().has('fin.reconciliations_pending') && registry.getFormulaCatalog().has('fin.anomalies_open'), true);
  assert.deepEqual(await registry.findInconsistentMetrics(null), [], 'toda métrica publicada aponta fórmula que existe no código');
});

test('m9d624 publicar de novo é idempotente e o hash do arquivo da fórmula fica na versão publicada', async () => {
  const t = env.cX;
  await kpis(t);
  await kpis(t);
  const [[n]] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open')", { replacements: { c: t.companyId } });
  assert.equal(n.n, 2);
  const [[v]] = await env.admin.query("SELECT v.formula_code_hash FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = 'fin.anomalies_open'", { replacements: { c: t.companyId } });
  assert.equal(v.formula_code_hash, registry.getFormulaCatalog().codeHash('fin.anomalies_open'));
});

test('m9d624 os parâmetros existem no SETTINGS_SCHEMA e rejeitam valor inválido', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_idade_extrato_dias'], { type: 'integer', min: 1, max: 365 });
  for (const key of ['analytics.conciliacao.faixas_idade_dias', 'analytics.owner.fin.reconciliations_pending', 'analytics.owner.fin.anomalies_open']) assert.equal(SETTINGS_SCHEMA[key].type, 'string', key);
  const validate = SETTINGS_SCHEMA['analytics.conciliacao.faixas_idade_dias'].validate;
  assert.doesNotThrow(() => validate('k', '2,7'));
  for (const bad of ['7,2', '2', '2,7,9', 'a,b', '2,2', '-1,5', '']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
});

test('m9d624 a origem do KPI está registrada e o teste de reconciliação do detalhe passa (modo do tipo)', async () => {
  const t = env.cX;
  const account = env624.ledger.uuid();
  const a = await bankTx(env, t, { account, amount: '10.00', date: dayAt(-2), createdAt: dayAt(-1) });
  await bankTx(env, t, { account, amount: '-5.00', date: dayAt(-3), createdAt: dayAt(-1) });
  await env624.reconcile(env, t, a);
  await refresh(t);
  const row = await env624.healthRow(env, t);
  for (const code of ['fin.reconciliations_pending', 'fin.anomalies_open']) {
    assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
    assert.ok(row.source_criteria[code], `${code} tem critério guardado no read model`);
  }
  await env624.inTx(t, {}, async (tx) => {
    const ctx = env624.ctxOf(t);
    const kpi = { 'fin.reconciliations_pending': row.pending_reconciliations, 'fin.anomalies_open': row.open_anomalies };
    for (const code of Object.keys(kpi)) {
      const { sourceRefs: [ref], reconcileMode } = await registry.buildSourceRefs(ctx, code, { filter: row.source_criteria[code], unit: 'COUNT' }, tx);
      assert.equal(reconcileMode, 'COUNT');
      const r = await registry.reconcileDetail(ctx, code, ref, kpi[code], { unit: 'COUNT' }, tx);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x read model ${r.kpi}`);
    }
  });
  assert.equal(row.pending_reconciliations, 1, 'a transação conciliada não conta no read model nem no detalhe');
});

test('m9d624 o refresh agendado da empresa grava os snapshots dos KPIs sozinho (ligação ao fim do lote)', async () => {
  const t = env.cY;
  await anomaly(env, t, { risk: 'HIGH', createdAt: dayAt(-1) });
  await env624.inTx(t, { commit: true }, async (tx) => {
    const params = await readModels.readRefreshParams(t, tx);
    await readModels.refreshCompanyScheduled({ companyId: t.companyId, groupId: t.groupId }, params, tx, { now: env.now });
  });
  const k = await readKpi(t, 'fin.anomalies_open').catch((e) => ({ error: e.code }));
  assert.equal(k.error, undefined, 'o snapshot existe sem chamada manual');
  assert.equal(Number(k.value), 1);
});

test('m9d624 nenhum KPI desta demanda é calculado no Front (guarda de soma/divisão) e as fórmulas são puras', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['finReconciliationsPending.js', 'finAnomaliesOpen.js', '_finKpi.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
});

test('m9d624 o Front tem o grupo de parâmetros e nenhum arquivo passa de 400 linhas', () => {
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biFinanceiroGroups.js'), 'utf8');
  for (const key of ['analytics.qualidade.max_idade_extrato_dias', 'analytics.conciliacao.faixas_idade_dias', 'analytics.owner.fin.reconciliations_pending', 'analytics.owner.fin.anomalies_open']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_FINANCEIRO_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
