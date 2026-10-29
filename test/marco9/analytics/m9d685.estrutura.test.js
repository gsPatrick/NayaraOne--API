'use strict';

// M9-D685 — Centro de Comando pela rota real: os 6 blocos na ordem do livro com o limite de itens, o mapa fechado item -> origem, a leitura só do schema analytics (BI-012),
// as recusas (403/404) e a meta p95. Os snapshots vêm do cenário-base (m9d685Env). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const e685 = require('../_helpers/m9d685Env');
const { sequelize } = require('../../../src/models');
const { ITEM_MAP, BLOCKS, DEPENDS_ON, ALERTS } = require('../../../src/features/analytics/dashboards/command/command.map');
const seed = require('../../../src/features/analytics/metrics/seed');
const { CENTRO_SETTINGS_SCHEMA, KEYS } = require('../../../src/features/analytics/centroSettings');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const { openCenter, blockOf, DIRECTOR } = e685;
let env;
const ORDER = ['ACONTECEU', 'DECISAO', 'RISCO', 'DINHEIRO', 'PRAZOS', 'OPORTUNIDADES'];
const code = (res) => res.body.code || (res.body.error && res.body.error.code);

before(async () => { env = await e685.setup(); await e685.clearQueueAndAlerts(env, env.tenantA); await e685.seedScenario(env); });
after(async () => { await e685.clearQueueAndAlerts(env, env.tenantA); await e685.teardown(env); });

test('m9d685 os 6 blocos aparecem na ordem com limite de itens', async () => {
  for (let i = 0; i < 7; i += 1) await e685.queueItem(env, env.tenantA, { kind: 'FIN_APPROVAL', hours: i + 1, title: `Pedido ${i}` });
  const res = await openCenter(env);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.blocks.map((b) => b.key), ORDER, 'as seis perguntas do livro, na ordem');
  assert.deepEqual(res.body.data.widgets.map((w) => w.type), ['QUALITY_BANNER', 'BRIEF', ...ORDER.map(() => 'COMMAND_BLOCK')], 'a faixa de qualidade é sempre o primeiro widget');
  assert.equal(res.body.data.widgets.filter((w) => w.type === 'COMMAND_BLOCK').length, 6, 'exatamente os 6 blocos pedidos pelo livro');
  for (const b of res.body.data.blocks) assert.ok(b.items.length <= 5, `${b.key}: no máximo 5 itens`);
  const decision = blockOf(res, 'DECISAO');
  assert.deepEqual([decision.items.length, decision.total, decision.shown], [5, 7, 5], 'sete itens na fila: cinco à vista e o total completo');
  assert.equal(decision.viewAllHref, '/painel/centro-de-comando?bloco=DECISAO', 'o link "Ver todos"');
  const all = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=DECISAO` });
  assert.equal(blockOf(all, 'DECISAO').items.length, 7, '"Ver todos" mostra o bloco por inteiro');
  assert.equal((await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=XYZ` })).status, 400);
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 cada item aponta para métrica ou alerta existente e leva ao painel de origem', async () => {
  await e685.alertOf(env, env.tenantA, { severity: 'CRITICAL', status: 'OPEN' });
  const res = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=RISCO` });
  const registry = new Set(seed.listCriticalityRows().map((r) => r.code));
  let total = 0;
  for (const block of res.body.data.blocks) {
    for (const item of block.items) {
      total += 1;
      const src = item.source;
      const codes = src.metricCodes || (src.metricCode ? [src.metricCode] : []);
      if (src.alertId) assert.ok(/^[0-9a-f-]{36}$/.test(src.alertId) && src.alertCode, `${item.id}: alerta de origem`);
      else assert.ok(codes.length > 0 && codes.every((c) => registry.has(c)), `${item.id}: a métrica de origem existe no registro`);
      assert.ok(item.link && item.link.href.startsWith('/painel/'), `${item.id}: leva ao painel de origem`);
      if (!src.alertId) assert.ok(item.metric && item.metric.freshness && item.metric.freshness.state, `${item.id}: o selo de atualização da métrica de origem`);
    }
  }
  assert.ok(total >= 6, 'o cenário-base gerou itens nos blocos');
  assert.ok(blockOf(res, 'RISCO').items.some((i) => i.source.alertId), 'o alerta aberto aparece com o alerta de origem');
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 todo tipo de item do mapa 3.2-A aponta para metric_code ou alert_code existente no registry', () => {
  const critical = new Set(seed.criticalCodes());
  const all = new Set(seed.listCriticalityRows().map((r) => r.code));
  assert.deepEqual([...new Set(ITEM_MAP.map((m) => m.block))].sort(), [...ORDER].sort(), 'o mapa só tem os 6 blocos');
  for (const entry of ITEM_MAP) {
    const { origin } = entry;
    if (origin.alert) { assert.equal(origin.alert, ALERTS, `${entry.type}: alert_instances`); continue; }
    if (origin.critical) continue; // variação de qualquer métrica CRITICAL da M9-D712: o código vem da própria tabela
    const codes = origin.metricCodes || [origin.metricCode];
    for (const c of codes) assert.ok(all.has(c) && critical.has(c), `${entry.type}: ${c} é métrica CRITICAL da tabela de criticidade`);
  }
  for (const block of BLOCKS) for (const c of DEPENDS_ON[block.key]) assert.ok(critical.has(c), `${block.key}: depende só de métricas CRITICAL (${c})`);
  assert.equal(ITEM_MAP.length, 26, 'a tabela 3.2-A tem as 26 linhas do mapa fechado (nenhum item fora dela)');
});

test('m9d685 tela toca só schema analytics e nenhuma consulta lê tabela de origem', async () => {
  await e685.queueItem(env, env.tenantA, { kind: 'FIN_APPROVAL' });
  await e685.queueItem(env, env.tenantA, { kind: 'INV_ADJUSTMENT' });
  await e685.queueItem(env, env.tenantA, { kind: 'RULE_APPROVAL' });
  const seen = [];
  const original = sequelize.query.bind(sequelize);
  sequelize.query = (sql, opts) => { seen.push(typeof sql === 'string' ? sql : sql.query); return original(sql, opts); };
  let res;
  try { res = await openCenter(env); } finally { sequelize.query = original; }
  assert.equal(res.status, 200);
  const tables = new Set();
  for (const sql of seen) for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_]+)"?\."?([a-z_0-9]+)"?/gi)) tables.add(`${m[1]}.${m[2]}`.toLowerCase());
  const foreign = [...tables].filter((t) => !t.startsWith('analytics.') && t !== 'core.tenant_settings');
  assert.deepEqual(foreign, [], 'nenhuma tabela fora do schema analytics (a leitura de parâmetros é a única exceção)');
  const text = seen.join('\n');
  for (const origin of ['approval_requests', 'adjustment_proposals', 'rule_approval_requests', 'ai_recommendations']) assert.ok(!text.includes(origin), `não lê ${origin}`);
  assert.ok(text.includes('rm_decision_queue'), 'a fila de decisão vem do read model');
  const dir = path.join(__dirname, '../../../src/features/analytics/dashboards/command');
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/require\('(\.\.\/)+models/.test(src) && !/sequelize/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), `${file}: a camada de painéis não importa o banco`);
  }
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 painel exige analytics:read, não encontra painel ou empresa de outro grupo e cumpre a meta p95', async () => {
  const denied = await openCenter(env, { perms: [] });
  assert.equal(denied.status, 403);
  const only = await openCenter(env, { perms: ['finance:read'] });
  assert.deepEqual([only.status, code(only)], [403, 'PERMISSION_DENIED']);
  assert.match(only.body.error.message, /analytics:read/);
  const missing = await e685.openPanel(env, 'centro_inexistente', { perms: DIRECTOR });
  assert.deepEqual([missing.status, code(missing)], [404, 'ANALYTICS_DASHBOARD_NOT_FOUND']);
  const other = await openCenter(env, { query: `asOf=${e685.AS_OF}&companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, code(other)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
  const ok = await openCenter(env);
  assert.equal(ok.body.data.p95TargetMs, 2500, 'meta p95 do livro gravada na definição');
  const started = process.hrtime.bigint();
  for (let i = 0; i < 5; i += 1) assert.equal((await openCenter(env)).status, 200);
  const average = Number(process.hrtime.bigint() - started) / 1e6 / 5;
  assert.ok(average < 2500, `abertura média de ${average.toFixed(0)} ms dentro da meta de 2.500 ms`);
});

test('m9d685 cada bloco declara em config.dependsOn as métricas de que depende e os parâmetros do administrador existem', async () => {
  const res = await openCenter(env);
  const widgets = res.body.data.widgets.filter((w) => w.type === 'COMMAND_BLOCK');
  for (const w of widgets) assert.deepEqual(w.config.dependsOn, DEPENDS_ON[w.config.blockKey], `${w.config.blockKey}: dependsOn`);
  assert.ok(widgets.every((w) => w.config.dependsOn.length >= 3));
  for (const key of Object.values(KEYS)) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} está no catálogo de parâmetros do administrador`);
    assert.deepEqual(SETTINGS_SCHEMA[key], CENTRO_SETTINGS_SCHEMA[key]);
  }
});
