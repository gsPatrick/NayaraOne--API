'use strict';

// M9-D686 — limiares versionados (mudar um limiar cria nova versão do painel, BI-008), parâmetros validados, formato do semáforo lido pelo briefing da NAY (M9-D693),
// "Ver detalhe" dos números críticos (M9-D690), selo de atualização (M9-D609) e áreas sem acesso. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e686 = require('../_helpers/m9d686Env');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { HEALTH_SETTINGS_SCHEMA, RULES, AREAS_KEY } = require('../../../src/features/analytics/healthSettings');
const { parseRule, ruleOfWidget, holds } = require('../../../src/features/analytics/dashboards/health/health.rules');
const { parseAreaKpis, DEFAULT_AREA_KPIS } = require('../../../src/features/analytics/dashboards/health/health.areas');
const { HEALTH_PANEL } = require('../../../src/features/analytics/dashboards/panels/health.panel');
const { compareThreshold } = require('../../../src/features/analytics/alerts');

const { ok, seedHealth, openHealth, areaOf, alertOf, clearHealth, setSetting, DIRECTOR } = e686;
let env;
const apply = (perms = DIRECTOR) => env.call('POST', '/analytics/dashboards/health/thresholds', { perms });
const versions = async () => (await env.admin.query(
  "SELECT company_id IS NULL AS global, version, status FROM analytics.dashboard_definitions WHERE dashboard_code = 'health' AND ((company_id IS NULL AND status = 'PUBLISHED') OR company_id = :c) ORDER BY company_id IS NULL DESC, version",
  { replacements: { c: env.tenantA.companyId } }
))[0];

before(async () => { env = await e686.setup(); await clearHealth(env); await seedHealth(env, { 'rent.vacancy': ok('7.50') }); });
after(async () => { await clearHealth(env); await e686.teardown(env); });

test('m9d686 mudança de limiar cria nova versão do painel', async () => {
  assert.deepEqual(await versions(), [{ global: true, version: 2, status: 'PUBLISHED' }], 'o padrão do livro é a versão 2 do catálogo global');
  assert.equal((await e686.areaOf(await openHealth(env), 'RENTAL')).light.color, 'VERDE', 'vacância de 7,5% com o padrão (amarelo acima de 10%): verde');
  const none = await apply();
  assert.deepEqual([none.status, none.body.data.changed], [200, false], 'sem mudança de parâmetro nada é publicado');
  assert.equal((await versions()).length, 1);
  await setSetting(env, env.tenantA, 'analytics.semaforo.rent_vacancy', 'AMARELO > 5%; VERMELHO > 7%');
  assert.equal((await e686.areaOf(await openHealth(env), 'RENTAL')).light.color, 'VERDE', 'mudar só o parâmetro não muda a cor: o limiar só vale numa nova versão');
  const first = await apply();
  assert.deepEqual([first.status, first.body.data.changed, first.body.data.version], [201, true, 1], JSON.stringify(first.body));
  assert.deepEqual(await versions(), [{ global: true, version: 2, status: 'PUBLISHED' }, { global: false, version: 1, status: 'PUBLISHED' }]);
  let rental = await e686.areaOf(await openHealth(env), 'RENTAL');
  assert.equal(rental.light.color, 'VERMELHO', 'com a versão da empresa, 7,5% passa do vermelho de 7%');
  const widget = (await openHealth(env)).body.data.widgets.find((w) => w.metricCode === 'rent.vacancy');
  assert.deepEqual([widget.config.trafficLight.yellow, widget.config.trafficLight.red], [{ operator: 'GT', value: 5 }, { operator: 'GT', value: 7 }]);
  assert.equal((await apply()).body.data.changed, false, 'repetir sem mudança não cria versão');
  await setSetting(env, env.tenantA, 'analytics.semaforo.rent_vacancy', 'AMARELO > 8%; VERMELHO > 12%');
  const second = await apply();
  assert.deepEqual([second.status, second.body.data.version, second.body.data.previousVersion], [201, 2, 1]);
  assert.deepEqual(await versions(), [{ global: true, version: 2, status: 'PUBLISHED' }, { global: false, version: 1, status: 'RETIRED' }, { global: false, version: 2, status: 'PUBLISHED' }], 'a versão anterior fica no histórico');
  rental = await e686.areaOf(await openHealth(env), 'RENTAL');
  assert.equal(rental.light.color, 'VERDE', '7,5% com o novo limiar (amarelo só acima de 8%): verde de novo');
});

test('m9d686 apenas quem tem analytics:manage aplica limiares e os parâmetros são validados', async () => {
  const denied = await apply(['analytics:read']);
  assert.deepEqual([denied.status, denied.body.code || denied.body.error.code], [403, 'PERMISSION_DENIED']);
  for (const key of [...Object.keys(RULES), AREAS_KEY]) assert.deepEqual(SETTINGS_SCHEMA[key], HEALTH_SETTINGS_SCHEMA[key], `${key} está no catálogo de parâmetros`);
  for (const [key, spec] of Object.entries(RULES)) {
    assert.ok(parseRule(spec.default), `${key}: o texto padrão é válido`);
    for (const bad of ['', 'VERDE > 1', 'AMARELO ~ 5', 'AMARELO > x', 'AMARELO > 1; AMARELO > 2', 'AMARELO > 1; VERMELHO > 2; VERMELHO > 3']) {
      assert.throws(() => HEALTH_SETTINGS_SCHEMA[key].validate(key, bad), (err) => err.code === 'SETTING_INVALID_VALUE', `${key}: ${bad}`);
    }
  }
  assert.deepEqual(parseRule('AMARELO < 99,9%; VERMELHO < 99%'), { yellow: { operator: 'LT', value: 99.9 }, red: { operator: 'LT', value: 99 } });
  assert.deepEqual(parseRule('AMARELO < -5 p.p.; VERMELHO < -10 p.p.'), { yellow: { operator: 'LT', value: -5 }, red: { operator: 'LT', value: -10 } });
  assert.deepEqual(parseRule('VERMELHO se > 0'), { red: { operator: 'GT', value: 0 } });
  assert.ok(parseAreaKpis(DEFAULT_AREA_KPIS));
  assert.equal(parseAreaKpis('FINANCE: legal.deadlines', (c) => ({ 'legal.deadlines': 'LEGAL' }[c])), null, 'o KPI precisa ser da própria área');
  assert.equal(parseAreaKpis('OUTRA: fin.free_cash'), null);
  assert.equal(parseAreaKpis('FINANCE: fin.free_cash; FINANCE: fin.breathing_need'), null);
  assert.throws(() => HEALTH_SETTINGS_SCHEMA[AREAS_KEY].validate(AREAS_KEY, 'FINANCE: legal.deadlines'), (err) => err.code === 'SETTING_INVALID_VALUE');
  await clearHealth(env);
  await setSetting(env, env.tenantA, AREAS_KEY, 'FINANCE: fin.free_cash, fin.breathing_need; LEGAL: legal.deadlines');
  await apply();
  const res = await openHealth(env);
  assert.deepEqual(res.body.data.areas.map((a) => [a.key, a.kpis.length]), [['FINANCE', 2], ['LEGAL', 1]], 'as áreas e os KPIs são do parâmetro do administrador');
  await clearHealth(env);
});

test('m9d686 o semáforo do KPI tem o formato que o briefing da NAY lê (red = { operator, value })', async () => {
  for (const w of HEALTH_PANEL.widgets.filter((x) => x.config && x.config.trafficLight)) {
    const rule = ruleOfWidget(w.config);
    assert.ok(rule, `${w.metricCode}: regra válida`);
    for (const level of ['yellow', 'red']) {
      if (!rule[level]) continue;
      assert.ok(['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NEQ'].includes(rule[level].operator) && typeof rule[level].value === 'number', `${w.metricCode}.${level}`);
    }
  }
  assert.equal(HEALTH_PANEL.widgets.filter((x) => x.config && x.config.trafficLight).length, 9, 'as nove regras do livro/CSV');
  for (const [value, operator, limit] of [['99.5', 'LT', 99.9], ['0', 'GT', 0], ['10.00', 'GTE', 10], ['3', 'EQ', 3], ['2', 'NEQ', 2]]) {
    assert.equal(holds(value, { operator, value: limit }), compareThreshold(value, operator, limit), `${value} ${operator} ${limit}: a mesma comparação do briefing`);
  }
  await seedHealth(env, { 'tec.availability': ok('98.00') });
  const { collectMetricFacts } = require('../../../src/features/analytics/briefs/brief.metrics');
  assert.equal(typeof collectMetricFacts, 'function');
  const widget = (await openHealth(env)).body.data.widgets.find((w) => w.metricCode === 'tec.availability');
  assert.equal(compareThreshold('98.00', widget.config.trafficLight.red.operator, widget.config.trafficLight.red.value), true, 'o briefing enxerga 98% como vermelho');
});

test('m9d686 cada número crítico tem "Ver detalhe" pelo sourceRefs, com recusa e agregado sem a permissão', async () => {
  await seedHealth(env);
  const withPerm = await openHealth(env, { perms: [...DIRECTOR, 'analytics:drilldown'] });
  const widgets = withPerm.body.data.widgets.filter((w) => w.metric);
  const critical = widgets.filter((w) => w.drilldown.enabled);
  // "Ver detalhe" só nos KPIs CRÍTICOS cujo snapshot traz origem assinada (sourceRefs); o fixture assina estes quatro (os demais ficam sem origem, sem botão)
  assert.deepEqual(critical.map((w) => w.metricCode).sort(), ['cor.commission', 'crm.opportunities_by_stage', 'legal.cases_by_risk', 'legal.deadlines'], 'os KPIs críticos com origem oferecem o detalhe');
  assert.ok(critical.every((w) => w.drilldown.sourceRef && w.drilldown.sourceRef.filterSignature), 'cada "Ver detalhe" leva o item de sourceRefs do número');
  assert.ok(widgets.every((w) => (w.drilldown.enabled ? Boolean(w.metric) : w.drilldown.allowed === false)));
  const deadlines = widgets.find((w) => w.metricCode === 'legal.deadlines');
  assert.deepEqual([deadlines.drilldown.enabled, deadlines.drilldown.allowed], [true, true]);
  const ref = deadlines.drilldown.sourceRef;
  assert.ok(ref && ref.filterSignature, 'o item de sourceRefs do número vai ao detalhe');
  const query = `filter=${encodeURIComponent(JSON.stringify(ref.filter))}&filterHash=${ref.filterHash}&filterSignature=${ref.filterSignature}&page=1&pageSize=20`;
  assert.equal((await env.call('GET', `/analytics/metrics/legal.deadlines/drilldown?${query}`, { perms: [...DIRECTOR, 'analytics:drilldown'] })).status, 200);
  const denied = await env.call('GET', `/analytics/metrics/legal.deadlines/drilldown?${query}`, { perms: DIRECTOR });
  assert.deepEqual([denied.status, denied.body.code || denied.body.error.code], [403, 'ANALYTICS_DRILLDOWN_FORBIDDEN']);
  assert.ok(JSON.stringify(denied.body).includes('aggregate'), 'a recusa traz o agregado permitido');
});

test('m9d686 selo de atualização de cada número (M9-D609) e área sem acesso em cinza, sem nenhum número', async () => {
  await seedHealth(env, {}, { stale: ['fin.free_cash'] });
  const res = await openHealth(env);
  const free = areaOf(res, 'FINANCE').kpis.find((k) => k.metricCode === 'fin.free_cash');
  assert.ok(['STALE', 'FRESH'].includes(free.metric.freshness.state) && free.metric.freshness.label, 'o rótulo de atualização vem do servidor');
  assert.equal(areaOf(res, 'FINANCE').freshness.metricCode, 'fin.free_cash', 'o pior KPI da área é o desatualizado');
  await seedHealth(env);
  await alertOf(env, env.tenantA, { metricCode: 'legal.deadlines', severity: 'CRITICAL', status: 'OPEN' });
  const limited = await openHealth(env, { perms: ['analytics:read', 'legal:read'] });
  const finance = areaOf(limited, 'FINANCE');
  assert.deepEqual([finance.noAccess, finance.light.color, finance.light.text, finance.kpis, finance.reasons], [true, 'CINZA', 'Sem acesso', [], []]);
  assert.equal(areaOf(limited, 'LEGAL').light.color, 'VERMELHO');
  const restricted = limited.body.data.widgets.filter((w) => w.config && w.config.area === 'FINANCE');
  assert.ok(restricted.length === 3 && restricted.every((w) => w.restricted === true && !w.metric && !w.view), 'nenhum número da área sem acesso sai nos widgets');
  assert.ok(!JSON.stringify(limited.body.data.areas.filter((a) => a.noAccess)).includes('R$'), 'nenhum valor das áreas sem acesso');
  const other = await openHealth(env, { perms: ['analytics:read', 'legal:read'], query: `asOf=${e686.AS_OF}&companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, other.body.code || (other.body.error && other.body.error.code)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
  assert.equal((await openHealth(env, { perms: [] })).status, 403);
  await clearHealth(env);
});
