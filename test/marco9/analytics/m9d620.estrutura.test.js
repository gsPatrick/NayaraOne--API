'use strict';

// M9-D620 — definição dos KPIs no registry, parâmetros do administrador, origem (sourceRefs) com reconciliação do detalhe, semente do registry,
// replay do mesmo evento e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const e620 = require('../_helpers/m9d620Env');
const { cashFromSource } = require('../_helpers/m9d620Oracle');
const asserts = require('../_helpers/readModelAsserts');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const readModels = require('../../../src/features/analytics/read-models');
const money = e620.money;
require('../../../src/features/analytics');

const { entry, account, run, setSetting, dayAt } = e620;
const API = path.join(__dirname, '..', '..', '..');
let env;
before(async () => { env = await e620.setup(); });
after(() => e620.teardown(env));

const definition = async (t, code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: t.companyId, code } }))[0][0];

async function scenario(t) {
  const acc = await account(env, t, { opening: '10000.00' });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '100000.00', account: acc, settled: dayAt(-3) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '8000.00', third: true, reference: 'Caução contrato 12', account: acc, settled: dayAt(-2) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '27000.00', third: true, reference: 'Repasse ao proprietário', account: acc, settled: dayAt(-1) });
  await entry(env, t, { nature: 'PAYABLE', amount: '20000.00', account: acc, settled: dayAt(-1) });
  await entry(env, t, { nature: 'ADJUSTMENT', type: 'DEBIT', amount: '1500.00', key: `intercompany-transfer:${e620.ledger.uuid()}:from`, account: acc, settled: dayAt(-1) });
  return acc;
}

test('m9d620 os dois KPIs existem no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade', async () => {
  const t = env.cX;
  await setSetting(env, t, 'analytics.owner.fin.third_party_cash', 'Controladoria (papel controller)');
  await scenario(t);
  await run(t);
  const free = await definition(t, 'fin.free_cash');
  assert.deepEqual([free.version, free.unit, free.formula_id, free.source_read_model, free.domain, free.status, free.value_nature, free.criticality, free.drilldown_enabled],
    [1, 'BRL', 'fin.free_cash', 'rm_finance_health', 'FINANCE', 'PUBLISHED', 'ACTUAL', 'CRITICAL', true]);
  assert.deepEqual(free.dimensions, ['empresa', 'conta bancária', 'centro de custo']);
  assert.equal(free.owner_role, 'Diretoria Financeira (papel financeiro-gestor)', 'owner padrão da demanda');
  assert.deepEqual([free.refresh_policy.mode, free.refresh_policy.maxStalenessMinutes], ['EVENT', 15]);
  assert.ok(free.quality_rule.referenceReport && free.quality_rule.requiredFields.includes('reconciliation_gap'));
  const third = await definition(t, 'fin.third_party_cash');
  assert.deepEqual([third.version, third.unit, third.formula_id, third.source_read_model, third.criticality, third.drilldown_enabled], [1, 'BRL', 'fin.third_party_cash', 'rm_finance_health', 'CRITICAL', true]);
  assert.deepEqual(third.dimensions, ['empresa', 'origem', 'pessoa detentora']);
  assert.equal(third.owner_role, 'Controladoria (papel controller)', 'o owner vem do parâmetro analytics.owner.fin.third_party_cash');
  assert.ok(registry.getFormulaCatalog().has('fin.free_cash') && registry.getFormulaCatalog().has('fin.third_party_cash'));
  assert.deepEqual(await registry.findInconsistentMetrics(null), [], 'toda métrica publicada aponta fórmula que existe no código');
});

test('m9d620 os parâmetros existem no SETTINGS_SCHEMA, rejeitam valor inválido e são lidos pelo cálculo', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.caixa.usar_saldo_abertura'], { type: 'boolean' });
  for (const key of ['analytics.owner.fin.free_cash', 'analytics.owner.fin.third_party_cash']) assert.equal(SETTINGS_SCHEMA[key].type, 'string', key);
  const terms = SETTINGS_SCHEMA['analytics.terceiros.termos_caucao'].validate;
  assert.doesNotThrow(() => terms('k', 'caução, caucao'));
  for (const bad of ['', ' , ', '100%', 'a_b', 'x'.repeat(41), 'a,b,c,d,e,f,g,h,i,j,k']) assert.throws(() => terms('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  const map = SETTINGS_SCHEMA['analytics.mapa_status.finance'].validate;
  assert.doesNotThrow(() => map('k', 'a pagar/receber = PENDING; liquidado = SETTLED; REVERSED e CANCELLED excluídos'));
  assert.doesNotThrow(() => map('k', 'liquidado = SETTLED,PARTIALLY_SETTLED'));
  for (const bad of ['', 'liquidado = PENDING', 'liquidado = REVERSED', 'qualquer coisa']) assert.throws(() => map('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
});

test('m9d620 os termos de origem e o mapa de status do administrador mudam a conta (caução, repasse, outro)', async () => {
  const t = env.cY;
  await entry(env, t, { nature: 'RECEIVABLE', amount: '100.00', third: true, reference: 'Garantia locatícia X', settled: dayAt(-1) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '50.00', third: true, reference: 'Caução Y', settled: dayAt(-1) });
  await run(t);
  assert.equal((await e620.readKpi(t, 'fin.third_party_cash', { dimensionKey: 'origem:OUTRO' })).value, '100.00');
  await setSetting(env, t, 'analytics.terceiros.termos_caucao', 'garantia');
  await run(t);
  assert.equal((await e620.readKpi(t, 'fin.third_party_cash', { dimensionKey: 'origem:CAUCAO' })).value, '100.00', 'agora "garantia" é caução');
  assert.equal((await e620.readKpi(t, 'fin.third_party_cash', { dimensionKey: 'origem:OUTRO' })).value, '50.00', 'e "Caução Y" caiu em outro');
  await entry(env, t, { nature: 'RECEIVABLE', amount: '7.00', status: 'PARTIALLY_SETTLED', settled: dayAt(-1) });
  assert.equal((await run(t)).free.value, '0.00', 'parcialmente liquidado não entra no mapa padrão');
  await setSetting(env, t, 'analytics.mapa_status.finance', 'liquidado = SETTLED,PARTIALLY_SETTLED');
  assert.equal((await run(t)).free.value, '7.00', 'o administrador pode incluir PARTIALLY_SETTLED no realizado');
});

test('m9d620 a origem dos KPIs está registrada e a reconciliação do detalhe passa (modo do tipo, com abertura e transferência)', async () => {
  const t = env.cX;
  const { free, third } = await run(t);
  const want = await cashFromSource(env, t, e620.AS_OF);
  assert.equal(free.value, want.freeCash);
  assert.equal(want.freeCash, '88500.00', 'abertura 10.000 + 100.000 - 20.000 - transferência 1.500');
  const row = await e620.healthRow(env, t);
  await e620.inTx(t, {}, async (tx) => {
    const ctx = e620.ctxOf(t);
    for (const [code, kpi] of [['fin.free_cash', free.value], ['fin.third_party_cash', third.value]]) {
      assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
      assert.ok(row.source_criteria[code], `${code} tem critério guardado no read model`);
      const { sourceRefs: [ref], reconcileMode } = await registry.buildSourceRefs(ctx, code, { filter: row.source_criteria[code], unit: 'BRL' }, tx);
      assert.equal(reconcileMode, 'SUM');
      const r = await registry.reconcileDetail(ctx, code, ref, kpi, { unit: 'BRL' }, tx);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x KPI ${r.kpi}`);
    }
  });
});

test('m9d620 o detalhe (drill-down) devolve o agregado igual ao KPI e as linhas-fonte dos lançamentos', async () => {
  const t = env.cX;
  const { free } = await run(t);
  const row = await e620.healthRow(env, t);
  await e620.inTx(t, {}, async (tx) => {
    await e620.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx }); // o log de acesso do detalhe grava em analytics
    const ctx = { ...e620.ctxOf(t), permissions: ['analytics:read', 'analytics:drilldown', 'finance:read'] };
    const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, 'fin.free_cash', { filter: row.source_criteria['fin.free_cash'], unit: 'BRL' }, tx);
    const body = await openDrilldown(ctx, { metricCode: 'fin.free_cash', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page: 1, pageSize: 50, route: '/t' }, tx);
    assert.equal(body.aggregate.total, e620.money.money(free.value), 'o total do detalhe é o valor do KPI (inclui abertura e transferência)');
    assert.equal(body.rows.length, 2, 'duas linhas do ledger próprio: a receita e a despesa');
    const rowsSum = money.money(money.toString(money.sum(body.rows.map((r) => r.contribution))));
    const adjustments = body.aggregate.adjustments;
    assert.deepEqual(adjustments.map((a) => [a.label, a.total]), [['Saldo de abertura das contas bancárias', '10000.00'], ['Transferências entre empresas liquidadas', '-1500.00']]);
    assert.equal(money.money(money.toString(money.sum([rowsSum, ...adjustments.map((a) => a.total)]))), body.aggregate.total, 'linhas do ledger + ajustes explícitos = total do detalhe = valor do KPI');
    assert.equal(rowsSum, '80000.00', 'a soma das linhas é só o ledger de receber e pagar: 100.000 - 20.000');
    assert.equal(body.reconcileMode, 'SUM');
  });
});

test('m9d620 a semente do registry publica a versão 1 dos dois KPIs com a fórmula do código e o read model existente', async () => {
  const rows = seed.listCriticalityRows().filter((r) => KPI_CODES.includes(r.code));
  assert.equal(rows.length, 2);
  await e620.inTx(env.cX, {}, async (tx) => {
    await e620.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx, { rows });
    assert.deepEqual(out.pending, [], 'nada pendente: a fórmula e o read model existem');
    for (const code of KPI_CODES) assert.ok(out.published.includes(code) || out.existing.includes(code), code);
  });
  for (const code of KPI_CODES) assert.equal(rows.find((r) => r.code === code).formulaId, code, 'a linha da tabela de criticidade aponta a fórmula entregue por esta demanda');
});
const KPI_CODES = ['fin.free_cash', 'fin.third_party_cash'];

test('m9d620 replay do mesmo evento não altera o valor', async () => {
  const t = env.cY;
  const ev = e620.event(t, 'finance.entry.settled');
  await asserts.assertReplayIdempotent({
    applyEvent: () => e620.inTx(t, { commit: true }, (tx) => readModels.applyEvent(ev, tx, { now: e620.NOW })),
    readRow: () => e620.healthRow(env, t),
  });
  const first = await e620.kpis(t);
  const again = await e620.kpis(t);
  assert.equal(again.written, 0, 'recalcular com o mesmo estado não grava revisão nova');
  assert.ok(first.kpis['fin.free_cash'] && first.kpis['fin.third_party_cash']);
});

test('m9d620 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e nenhum arquivo passa de 400 linhas', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  const rules = spawnSync('node', ['scripts/analytics/checkGuardrails.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(rules.status, 0, 'a regra 3 (caixa livre só com fundos próprios) passa: ' + rules.stdout + rules.stderr);
  for (const f of ['finFreeCash.js', 'finThirdPartyCash.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biCaixaGroups.js'), 'utf8');
  for (const key of ['analytics.caixa.usar_saldo_abertura', 'analytics.terceiros.termos_caucao', 'analytics.terceiros.termos_repasse', 'analytics.mapa_status.finance',
    'analytics.owner.fin.free_cash', 'analytics.owner.fin.third_party_cash']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_CAIXA_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
