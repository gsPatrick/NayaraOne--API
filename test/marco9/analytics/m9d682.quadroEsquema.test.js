'use strict';

// M9-D682 — quadro de integrações do painel Segurança/Integrações/IA (8 métricas do livro, 9 valores, por fornecedor, ambiente e família, as 14 famílias), o painel lê só o schema
// analytics (BI-012), responde dentro da meta p95 (1.400 ms), está publicado como versão 2 da definição global com a permissão técnica e a migration do conteúdo é idempotente e reversível.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env682 = require('../_helpers/painelTechEnv');
const q = require('../_helpers/m9d698Queries');
const migration = require('../../../migrations/20260101009892-publish-analytics-tech-dashboard-content');
const { TECH_PANEL } = require('../../../src/features/analytics/dashboards/panels');
const { DOMAINS, DOMAIN_LABELS } = require('../../../src/features/integrations/providers/catalog.domains');
const { INTEGRATION_FAMILIES } = require('../../../src/features/analytics/dashboards/panels/integrationFamilies');

const { TECH_USER, openPanel, seedPanel, reseedMetric, healthRow, integrationsResult } = env682;
const seedMetric = (t, code, opts) => reseedMetric(env, t, code, opts);
const NINE = ['sucesso_pct', 'latencia_p95_ms', 'latencia_p99_ms', 'limite_taxa_qtd', 'falhas_auth_qtd', 'tentativas_qtd', 'dlq_qtd', 'fila_qtd', 'cota_qtd'];
let env;
before(async () => { env = await env682.setup(); await seedPanel(env.tenantA, TECH_PANEL); });
after(() => env682.teardown(env));

const globalRows = () => env.admin.query(
  "SELECT id, version, status, p95_target_ms, required_permission FROM analytics.dashboard_definitions WHERE dashboard_code = 'tech' AND company_id IS NULL AND group_id IS NULL ORDER BY version"
).then(([rows]) => rows);
const board = async (perms = TECH_USER) => (await openPanel(env, 'tech', { perms })).body.data.widgets.find((w) => w.metricCode === 'tec.integration_errors');

test('m9d682 as 14 famílias do quadro são as do catálogo de integrações', () => {
  assert.deepEqual(INTEGRATION_FAMILIES.map((f) => f.id), DOMAINS, 'mesmos códigos, na mesma ordem');
  assert.deepEqual(INTEGRATION_FAMILIES.map((f) => f.label), DOMAINS.map((d) => DOMAIN_LABELS[d]), 'mesmos nomes do livro');
});

test('m9d682 quadro de integrações mostra as 8 métricas do livro (9 valores) e as 14 famílias', async () => {
  assert.equal(DOMAINS.length, 14, 'as 14 famílias do catálogo da M9-D201');
  const rows = DOMAINS.map((family, i) => healthRow(`${family.toLowerCase()}-sandbox`, family, i % 2 ? 'SANDBOX' : 'PRODUCTION', { calls: 100, errors: i === 0 ? 12 : 0, successRate: i === 0 ? '88.00' : '100.00', latencyP95Ms: 300 + i }));
  await seedMetric(env.tenantA, 'tec.integration_errors', { result: integrationsResult(rows) });
  const w = await board();
  assert.deepEqual(w.view.partColumns, ['Fornecedor', 'Ambiente', 'Família']);
  assert.deepEqual(w.view.columns.map((c) => c.label), ['Sucesso', 'Latência p95', 'Latência p99', 'Limite de taxa', 'Falhas de autenticação', 'Tentativas', 'DLQ', 'Fila', 'Cota restante'], 'as 8 métricas do livro: 9 valores (a latência traz p95 e p99)');
  assert.deepEqual(w.view.partGroups.map((g) => g.id), DOMAINS, 'as 14 famílias, na ordem do catálogo');
  assert.equal(w.view.partGroups.length, 14);
  for (const g of w.view.partGroups) {
    assert.equal(g.rows.length, 1, `${g.id}: um fornecedor`);
    const [row] = g.rows;
    assert.equal(row.parts[2], g.id, 'a terceira parte do código da linha é a família');
    assert.equal(row.cells.length, 9, `${g.id}: 9 valores por linha`);
    assert.deepEqual(row.cells.map((c) => c.key), NINE);
    assert.ok(row.cells.every((c) => c.formatted !== null), `${g.id}: nenhum valor vazio`);
  }
  const first = w.view.partGroups[0].rows[0];
  assert.deepEqual(first.cells.slice(0, 2).map((c) => c.formatted), ['88,00%', '300 ms'], 'unidade de cada valor: percentual e milissegundos');
  assert.equal(w.view.alert, true, 'o fornecedor com 12% de erro acende o alerta do cartão');
  assert.equal(w.view.facts[0].formatted, '1');
  assert.equal(w.metric.formatted, '0,86%', 'o valor do cartão continua sendo o percentual de erro de todas as chamadas (12 erros em 1.400)');
});

test('m9d682 o quadro sem fornecedor numa família mostra a família vazia e fornecedor de família fora do catálogo vai em Outras', async () => {
  const rows = [healthRow('portal-sandbox', 'PORTAL', 'PRODUCTION'), healthRow('legado', 'LEGADO', 'PRODUCTION')];
  await seedMetric(env.tenantA, 'tec.integration_errors', { result: integrationsResult(rows) });
  const w = await board();
  assert.equal(w.view.partGroups.find((g) => g.id === 'PORTAL').rows.length, 1);
  assert.equal(w.view.partGroups.find((g) => g.id === 'MESSAGING').rows.length, 0, 'família sem integração ativa continua na lista');
  assert.deepEqual(w.view.partGroups.at(-1).id, 'OUTRAS');
  assert.equal(w.view.partGroups.at(-1).rows[0].parts[2], 'LEGADO');
});

test('m9d682 integração em erro: 12,00% e alerta; sem erro, sem alerta', async () => {
  await seedMetric(env.tenantA, 'tec.integration_errors', { result: integrationsResult([healthRow('portal-sandbox', 'PORTAL', 'PRODUCTION', { calls: 200, errors: 24, successRate: '88.00' })]) });
  const bad = await board();
  assert.deepEqual([bad.metric.formatted, bad.view.alert], ['12,00%', true]);
  await seedMetric(env.tenantA, 'tec.integration_errors', { result: integrationsResult([healthRow('portal-sandbox', 'PORTAL', 'PRODUCTION', { calls: 200, errors: 0 })]) });
  assert.deepEqual([(await board()).metric.formatted, (await board()).view.alert], ['0,00%', false]);
});

test('m9d682 painel toca só schema analytics', async () => {
  const run = await q.capture(env.admin, async () => {
    for (let i = 0; i < 20; i += 1) assert.equal((await openPanel(env, 'tech', { perms: [...TECH_USER, 'analytics:drilldown'] })).status, 200);
  });
  assert.ok(run.sql.length >= 100, `a instrumentação viu só ${run.sql.length} consultas`);
  assert.ok(run.sql.some((s) => /analytics\.metric_snapshots/i.test(s)));
  assert.deepEqual(run.sources, [], `tabela de origem tocada:\n${run.sources.slice(0, 3).join('\n')}`);
});

test('m9d682 p95 dentro da meta da definição', async () => {
  const target = (await globalRows()).find((r) => r.status === 'PUBLISHED').p95_target_ms;
  assert.equal(target, 1400, 'meta do livro');
  const times = [];
  for (let i = 0; i < 40; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await openPanel(env, 'tech', { perms: [...TECH_USER, 'analytics:drilldown'] });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(res.status, 200);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  assert.ok(p95 <= target, `p95 ${p95.toFixed(0)} ms acima da meta de ${target} ms`);
});

test('m9d682 versão 2 vigente do painel, com a permissão técnica e os widgets do livro', async () => {
  const rows = await globalRows();
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
  assert.equal(rows[1].required_permission, 'analytics:read:tech');
  const [widgets] = await env.admin.query('SELECT position, widget_type, metric_code FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position', { replacements: { id: rows[1].id } });
  assert.deepEqual(widgets.map((w) => [w.position, w.widget_type, w.metric_code]), TECH_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
});

test('m9d682 migration do conteúdo é idempotente e reversível', async () => {
  await migration.up({ sequelize: env.admin });
  assert.equal((await globalRows()).length, 2, 'rodar de novo não cria versão');
  await migration.down({ sequelize: env.admin });
  assert.deepEqual((await globalRows()).map((r) => [r.version, r.status]), [[1, 'PUBLISHED']]);
  await migration.up({ sequelize: env.admin });
  assert.deepEqual((await globalRows()).map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
});
