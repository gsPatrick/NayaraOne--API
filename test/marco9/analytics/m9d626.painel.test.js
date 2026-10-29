'use strict';

// M9-D626 — painel Financeiro (finance) pela rota real: 13 widgets na ordem, faixa de qualidade primeiro, rótulos de natureza, matriz de contas a pagar e a receber (2 x 3),
// valores iguais aos do endpoint de métrica, "Dado incompleto" em cada grupo de indicadores, texto do horizonte, alerta pelo limiar do alerta publicado (ou do parâmetro) e recusas.
// Os snapshots vêm dos casos de teste das fórmulas (o cálculo tem testes próprios). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envFin = require('../_helpers/painelFinEnv');
const { FINANCE_PANEL, MATRIX } = require('../../../src/features/analytics/dashboards/panels/finance.panel');

const { FIN_USER, openPanel, getMetric, seedMetric, cleanup, publishAll } = envFin;
const MATRIX_CODES = MATRIX.rows.flatMap((r) => r.metrics);
const CODES = [...new Set(FINANCE_PANEL.widgets.filter((w) => w.metricCode).flatMap((w) => [w.metricCode, ...(w.config.matrix ? MATRIX_CODES : [])]))];
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const widgets = (res) => res.body.data.widgets;
const by = (res, c) => widgets(res).find((w) => w.metricCode === c);
const cells = (res) => by(res, 'fin.payables_7d').view.matrix.rows.flatMap((r) => r.cells);
const GROUPS = {
  caixa: ['fin.free_cash', 'fin.third_party_cash'],
  janelas: MATRIX_CODES,
  vencidos: ['fin.overdue_receivables', 'fin.delinquency_rate', 'fin.breathing_need'],
  setores: ['fin.sector_margin', 'fin.commissions_provisioned', 'fin.commissions_paid', 'fin.owner_repasses_pending'],
  pendencias: ['fin.reconciliations_pending', 'fin.anomalies_open'],
};
const BREATHING_INPUTS = ['fin.free_cash', 'fin.payables_30d'];
let env;
/** Apaga e regrava os snapshots dos 17 indicadores (o snapshot da data-base não se sobrescreve): `results` troca o resultado de alguns, `degraded` degrada outros. */
const reseed = async (opts = {}) => {
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  for (const c of CODES) await seedMetric(env.tenantA, c, { degraded: (opts.degraded || []).includes(c), result: (opts.results || {})[c] });
};
const setSetting = (key, value) => env.admin.query(
  'INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST(:v AS jsonb)) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value',
  { replacements: { g: env.tenantA.groupId, c: env.tenantA.companyId, k: key, v: JSON.stringify(value) } });
const withAlert = async (metricCode, threshold, version = 1) => {
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query(
      `INSERT INTO analytics.alert_definitions (group_id, company_id, alert_code, metric_code, condition_type, threshold, severity, owner_role, status, version, published_at)
       VALUES (:g, :c, :a, :m, 'THRESHOLD', CAST(:t AS jsonb), 'WARNING', 'financeiro', 'PUBLISHED', :v, now())`,
      { replacements: { g: env.tenantA.groupId, c: env.tenantA.companyId, a: `m9d626_${metricCode.replace('.', '_')}`, m: metricCode, t: JSON.stringify(threshold), v: version }, transaction });
  });
};

before(async () => { env = await envFin.setup(); await reseed(); });
after(async () => {
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'analytics.painel.financeiro.%'", { replacements: { c: env.tenantA.companyId } });
  await env.admin.query("DELETE FROM analytics.alert_definitions WHERE alert_code LIKE 'm9d626_%'");
  await envFin.teardown(env);
});

test('m9d626 painel finance devolve widgets na ordem definida', async () => {
  const res = await openPanel(env, 'finance', { perms: FIN_USER });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.dashboardCode, 'finance');
  assert.equal(widgets(res).length, 13, 'faixa de qualidade mais os 12 blocos do livro (a matriz de janelas é um só widget)');
  assert.deepEqual(widgets(res).map((w) => [w.position, w.type, w.metricCode]), FINANCE_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
  assert.deepEqual(widgets(res).filter((w) => w.metric && !w.view.matrix).map((w) => w.metricCode), [
    'fin.free_cash', 'fin.third_party_cash', 'fin.breathing_need', 'fin.overdue_receivables', 'fin.delinquency_rate', 'fin.sector_margin',
    'fin.commissions_provisioned', 'fin.commissions_paid', 'fin.owner_repasses_pending', 'fin.reconciliations_pending', 'fin.anomalies_open',
  ]);
  const matrix = by(res, 'fin.payables_7d').view.matrix;
  assert.deepEqual(matrix.columns, ['7 dias', '30 dias', '60 dias']);
  assert.deepEqual(matrix.rows.map((r) => [r.label, r.cells.map((c) => c.metricCode)]), [
    ['A pagar', ['fin.payables_7d', 'fin.payables_30d', 'fin.payables_60d']], ['A receber', ['fin.receivables_7d', 'fin.receivables_30d', 'fin.receivables_60d']],
  ]);
});

test('m9d626 faixa de qualidade vem antes dos números', async () => {
  const res = await openPanel(env, 'finance', { perms: FIN_USER });
  const first = widgets(res)[0];
  assert.deepEqual([first.type, first.position, first.banner.visible, first.banner.degradedMetrics], ['QUALITY_BANNER', 0, false, []], 'dados frescos: sem aviso');
  const old = await openPanel(env, 'finance', { perms: FIN_USER, query: 'asOf=2026-10-20' });
  assert.equal(widgets(old)[0].type, 'QUALITY_BANNER');
  assert.deepEqual(widgets(old)[0].banner.degradedMetrics.map((d) => d.metricCode).sort(), [...CODES].sort(), 'os 17 indicadores sem registro na data-base aparecem na faixa, inclusive os da matriz');
});

test('m9d626 rótulos de natureza presentes', async () => {
  const res = await openPanel(env, 'finance', { perms: FIN_USER });
  for (const w of widgets(res).filter((x) => x.metric && !x.view.matrix)) assert.ok(['Realizado', 'Previsto', 'Estimado', 'Projetado'].includes(w.metric.valueNatureLabel), `${w.metricCode}: sem rótulo de natureza`);
  assert.equal(by(res, 'fin.free_cash').metric.valueNatureLabel, 'Realizado');
  assert.equal(by(res, 'fin.breathing_need').metric.valueNatureLabel, 'Projetado');
  for (const cell of cells(res)) assert.deepEqual([cell.metric.valueNatureLabel, cell.metric.freshness.state], ['Previsto', 'FRESH'], cell.metricCode);
  assert.equal(by(res, 'fin.free_cash').metric.freshness.state, 'FRESH');
  assert.equal(by(res, 'fin.free_cash').title, 'Caixa livre');
  assert.equal(by(res, 'fin.third_party_cash').title, 'Dinheiro de terceiros (não é caixa livre)');
});

test('m9d626 valores do painel iguais aos do endpoint de métrica (a tela só desenha o que a API devolveu)', async () => {
  const res = await openPanel(env, 'finance', { perms: FIN_USER });
  const views = [...widgets(res).filter((w) => w.metric && !w.view.matrix), ...cells(res)];
  assert.equal(views.length, 17);
  for (const w of views) {
    const direct = await getMetric(env, w.metricCode, FIN_USER);
    assert.equal(direct.status, 200, `${w.metricCode}: ${JSON.stringify(direct.body)}`);
    const d = direct.body.data;
    assert.deepEqual([w.metric.value, w.metric.status, w.metric.version, w.metric.unit, w.metric.valueNature, w.metric.formatted], [d.value, d.status, d.version, d.unit, d.valueNature, d.formatted], w.metricCode);
  }
});

test('m9d626 matriz de contas a pagar e a receber: 2 linhas x 3 colunas com o valor pronto em pt-BR', async () => {
  const values = { 'fin.payables_7d': '15000.00', 'fin.payables_30d': '22000.00', 'fin.payables_60d': '40500.00', 'fin.receivables_7d': '18000.00', 'fin.receivables_30d': '65000.00', 'fin.receivables_60d': '112500.00' };
  await reseed({ results: Object.fromEntries(Object.entries(values).map(([c, value]) => [c, { value, status: 'OK', dimensions: [] }])) });
  const matrix = by(await openPanel(env, 'finance', { perms: FIN_USER }), 'fin.payables_7d').view.matrix;
  assert.deepEqual(matrix.rows.map((r) => r.cells.map((c) => c.metric.formatted)), [['R$ 15.000,00', 'R$ 22.000,00', 'R$ 40.500,00'], ['R$ 18.000,00', 'R$ 65.000,00', 'R$ 112.500,00']]);
  await reseed();
});

test('m9d626 indicador DEGRADED ou INCOMPLETE mostra Dado incompleto no lugar do número, em cada grupo do painel', async () => {
  for (const [group, list] of Object.entries(GROUPS)) {
    await reseed({ degraded: list });
    // A necessidade para respirar herda o estado do caixa livre e das contas a pagar em 30 dias (M9-D622/M9-D697): componente degradado a deixa sem número.
    const expected = [...new Set([...list, ...(list.some((c) => BREATHING_INPUTS.includes(c)) ? ['fin.breathing_need'] : [])])];
    const res = await openPanel(env, 'finance', { perms: FIN_USER });
    const shown = [...widgets(res).filter((w) => w.metric && !w.view.matrix), ...cells(res)];
    for (const w of shown.filter((x) => expected.includes(x.metricCode))) {
      assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText], [true, null, null, 'Dado incompleto'], `${group}: ${w.metricCode}`);
      assert.ok(['DEGRADED', 'INCOMPLETE'].includes(w.metric.status), `${w.metricCode}: ${w.metric.status}`);
      assert.deepEqual([(w.view || {}).items || [], (w.view || {}).facts || [], (w.view || {}).series || []], [[], [], []], `${w.metricCode}: nenhuma linha, fato ou série com número`);
    }
    for (const w of shown.filter((x) => !expected.includes(x.metricCode))) assert.equal(w.metric.incomplete, false, `${group}: ${w.metricCode} segue com número`);
    assert.deepEqual(widgets(res)[0].banner.degradedMetrics.map((d) => d.metricCode).sort(), [...expected].sort(), `${group}: a faixa antes dos cartões lista exatamente os sem número`);
  }
  await reseed();
});

test('m9d626 necessidade para respirar: 0,00 mostra Sem necessidade no horizonte; com valor, não; o horizonte vem escrito', async () => {
  const need = (value) => reseed({ results: { 'fin.breathing_need': { value, status: 'OK', dimensions: [{ key: 'vencido_a_pagar_brl', value: '1000.00' }, { key: 'a_pagar_30d_brl', value: '2000.00' }, { key: 'comissoes_brl', value: '0.00' }, { key: 'caixa_livre_brl', value: '500.00' }] } } });
  await need('0.00');
  let card = by(await openPanel(env, 'finance', { perms: FIN_USER }), 'fin.breathing_need');
  assert.deepEqual([card.view.zeroText, card.metric.formatted], ['Sem necessidade no horizonte', 'R$ 0,00']);
  assert.match(card.view.horizonText, /Horizonte de 30 dias/);
  await need('2500.00');
  card = by(await openPanel(env, 'finance', { perms: FIN_USER }), 'fin.breathing_need');
  assert.deepEqual([card.view.zeroText, card.metric.formatted, card.view.facts.map((f) => f.formatted)], [undefined, 'R$ 2.500,00', ['R$ 1.000,00', 'R$ 2.000,00', 'R$ 0,00', 'R$ 500,00']]);
  await reseed();
});

test('m9d626 margem por setor: percentual de cada setor pronto da API, sem conta no painel', async () => {
  const dims = [['s1', '80000.00', '52000.00', '28000.00', '35.00'], ['s2', '100000.00', '61500.00', '38500.00', '38.50']]
    .flatMap(([id, rev, cost, margin, pct]) => [{ key: `setor:${id}:receita_brl`, value: rev }, { key: `setor:${id}:custo_brl`, value: cost }, { key: `setor:${id}:margem_brl`, value: margin }, { key: `setor:${id}:margem_pct`, value: pct }]);
  await reseed({ results: { 'fin.sector_margin': { value: '66500.00', status: 'OK', dimensions: dims } } });
  const card = by(await openPanel(env, 'finance', { perms: FIN_USER }), 'fin.sector_margin');
  assert.equal(card.view.labelKind, 'RESULT_CENTER');
  assert.deepEqual(card.view.items.map((i) => [i.id, i.formatted, i.extra.map((x) => x.formatted)]), [['s2', 'R$ 38.500,00', ['38,50%', 'R$ 100.000,00', 'R$ 61.500,00']], ['s1', 'R$ 28.000,00', ['35,00%', 'R$ 80.000,00', 'R$ 52.000,00']]]);
  await reseed();
});

test('m9d626 conciliações e anomalias acendem o alerta pelo limiar do alerta publicado; sem ele, pelo parâmetro do administrador', async () => {
  const set = (rec, ano) => reseed({ results: {
    'fin.reconciliations_pending': { value: rec, status: 'OK', dimensions: [{ key: 'valor_brl', value: '10.50' }, { key: 'mais_antiga_dias', value: '2' }] },
    'fin.anomalies_open': { value: ano, status: 'OK', dimensions: [{ key: 'alto', value: '1' }, { key: 'mais_antiga_dias', value: '8' }] },
  } });
  const alerts = async () => { const r = await openPanel(env, 'finance', { perms: FIN_USER }); return [by(r, 'fin.reconciliations_pending').view, by(r, 'fin.anomalies_open').view]; };
  await set('3', '5');
  let [rec, ano] = await alerts();
  assert.deepEqual([rec.alert, ano.alert, rec.alertLimit.source, rec.alertLimit.value], [true, true, 'PARAMETRO', 0], 'padrão 0: qualquer pendência acende');
  await set('0', '0');
  [rec, ano] = await alerts();
  assert.deepEqual([rec.alert, ano.alert], [false, false], 'zero não acende');
  await setSetting('analytics.painel.financeiro.limiar_conciliacoes_pendentes', 5);
  await setSetting('analytics.painel.financeiro.limiar_anomalias_abertas', 10);
  await set('3', '5');
  [rec, ano] = await alerts();
  assert.deepEqual([rec.alert, ano.alert, ano.alertLimit.value], [false, false, 10], 'o limiar do parâmetro vale');
  await set('6', '11');
  [rec, ano] = await alerts();
  assert.deepEqual([rec.alert, ano.alert], [true, true], 'acima do limiar do parâmetro');
  await withAlert('fin.reconciliations_pending', { operator: 'GT', value: 7 });
  await withAlert('fin.anomalies_open', { operator: 'GTE', value: 11 });
  [rec, ano] = await alerts();
  assert.deepEqual([rec.alert, rec.alertLimit.source, rec.alertLimit.value, ano.alert, ano.alertLimit.operator], [false, 'ALERTA_PUBLICADO', 7, true, 'GTE'], 'o alerta publicado manda no lugar do parâmetro');
  await set('8', '10');
  [rec, ano] = await alerts();
  assert.deepEqual([rec.alert, ano.alert], [true, false], 'GT 7 com 8 acende; GTE 11 com 10 não');
  await env.admin.query("DELETE FROM analytics.alert_definitions WHERE alert_code LIKE 'm9d626_%'");
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'analytics.painel.financeiro.%'", { replacements: { c: env.tenantA.companyId } });
  await reseed();
});

test('m9d626 painel sem permissão devolve 403', async () => {
  assert.equal((await openPanel(env, 'finance', { perms: [] })).status, 403);
  const only = await openPanel(env, 'finance', { perms: ['analytics:read'] });
  assert.deepEqual([only.status, code(only)], [403, 'PERMISSION_DENIED']);
  assert.match(only.body.error.message, /finance:read/);
  assert.equal((await openPanel(env, 'finance', { perms: ['finance:read'] })).status, 403, 'sem analytics:read nenhum painel abre');
  const missing = await openPanel(env, 'financeiro', { perms: FIN_USER });
  assert.deepEqual([missing.status, code(missing)], [404, 'ANALYTICS_DASHBOARD_NOT_FOUND']);
  const other = await openPanel(env, 'finance', { perms: FIN_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, code(other)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
});
