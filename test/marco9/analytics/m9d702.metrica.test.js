'use strict';

// M9-D702 — GET /analytics/metrics/:code pela rota real: contrato da resposta, formas de período, data-base, parâmetro desconhecido, recusas,
// dimensão e comparação. Banco descartável (127.0.0.1). A métrica de teste é do domínio Financeiro (prefixo fin).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e609 = require('../_helpers/m9d609Env');
const { startServer, snapshotAt, codeOf, messageOf } = require('../_helpers/m9d702Env');

const FIN = ['analytics:read', 'finance:read'];
const NOW = '2026-10-28T15:00:00Z';
const REFS = [{ type: 'TABLE', table: 'finance.financial_entries', filterHash: 'a'.repeat(64), filterSignature: 'assinatura', count: 3 }];
let env;
let srv;
let m;
let url;

before(async () => {
  env = await e609.setup();
  srv = await startServer(env);
  e609.at(NOW);
  m = await e609.publish(env, env.tenantA, { criticality: 'CRITICAL', maxStalenessMinutes: 60, validFrom: '2025-01-01' });
  url = (qs = '') => `/analytics/metrics/${m.code}${qs}`;
  const snap = (o) => snapshotAt(e609.sup, env.tenantA, m, o);
  await snap({ asOfDate: '2026-10-28', periodStart: '2026-10-01', periodEnd: '2026-10-31', value: '120000', sourceSnapshotAt: '2026-10-28T14:48:00Z', refreshedAt: '2026-10-28T14:49:00Z', sourceRefs: REFS });
  await snap({ asOfDate: '2026-10-28', periodStart: '2026-10-01', periodEnd: '2026-10-31', value: '70000', dimensionKey: 'company=matriz', sourceSnapshotAt: '2026-10-28T14:48:00Z' });
  await snap({ asOfDate: '2026-10-28', periodStart: '2026-10-01', periodEnd: '2026-10-31', value: '50000', dimensionKey: 'company=filial', sourceSnapshotAt: '2026-10-28T14:48:00Z' });
  await snap({ asOfDate: '2026-10-20', periodStart: '2026-10-01', periodEnd: '2026-10-31', value: '90000', sourceRefs: REFS });
  await snap({ asOfDate: '2026-09-30', periodStart: '2026-09-01', periodEnd: '2026-09-30', value: '100000', sourceRefs: REFS });
  await snap({ asOfDate: '2025-10-31', periodStart: '2025-10-01', periodEnd: '2025-10-31', value: '80000', sourceRefs: REFS });
});
after(async () => { await srv.close(); await e609.teardown(env); });

const get = (qs, opts = {}) => srv.call('GET', url(qs), { perms: FIN, ...opts });

test('m9d702 contrato da resposta de métrica tem todos os campos e números como string', async () => {
  const res = await get(`?companyId=${env.tenantA.companyId}&period=2026-10`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  for (const k of ['metricCode', 'name', 'version', 'unit', 'valueNature', 'value', 'formatted', 'status', 'valueReliable', 'period', 'freshness', 'quality', 'sourceRefs', 'components', 'variation', 'drilldown', 'owner']) {
    assert.ok(k in d, `falta o campo ${k}`);
  }
  assert.equal(d.metricCode, m.code);
  assert.equal(d.name, 'Caixa livre');
  assert.equal(typeof d.value, 'string', 'número como texto decimal, nunca float JSON');
  assert.equal(d.value, '120000.0000');
  assert.equal(d.formatted, '120.000', 'a unidade da métrica de teste é COUNT: texto pt-BR pronto, sem casas');
  assert.deepEqual([d.status, d.valueReliable, d.valueNature, d.owner, d.version], ['OK', true, 'ACTUAL', 'CFO', 1]);
  assert.deepEqual(d.period, { start: '2026-10-01', end: '2026-10-31', asOf: '2026-10-28', tz: 'America/Sao_Paulo', label: 'outubro de 2026', kind: 'MONTH' });
  assert.deepEqual([d.freshness.state, d.freshness.ageMinutes, d.freshness.maxStalenessMinutes], ['FRESH', 12, 60]);
  assert.ok(d.freshness.sourceSnapshotAt && d.freshness.refreshedAt);
  assert.ok(Array.isArray(d.quality.checks) && Array.isArray(d.quality.degradedReasons));
  assert.deepEqual(d.components, []);
  assert.equal(d.variation, null);
  assert.equal(d.sourceRefs.length, 1);
  assert.deepEqual([d.drilldown.enabled, d.drilldown.allowed], [true, false], 'CRITICAL com origem tem detalhe; sem analytics:drilldown não é permitido');
  const withDrill = await get('?period=2026-10', { perms: [...FIN, 'analytics:drilldown'] });
  assert.deepEqual([withDrill.body.data.drilldown.enabled, withDrill.body.data.drilldown.allowed], [true, true]);
  assert.doesNotMatch(JSON.stringify(res.body), /"value":\s*[0-9]/, 'nenhum número JSON no valor');
});

test('m9d702 a rota aceita period, month, quarter, year e from/to pelo resolvePeriod', async () => {
  const want = {
    'period=2026-10': ['2026-10-01', '2026-10-31', 'MONTH'], 'month=2026-10': ['2026-10-01', '2026-10-31', 'MONTH'],
    'period=2026-Q4': ['2026-10-01', '2026-12-31', 'QUARTER'], 'quarter=2026-Q4': ['2026-10-01', '2026-12-31', 'QUARTER'],
    'period=2026': ['2026-01-01', '2026-12-31', 'YEAR'], 'year=2026': ['2026-01-01', '2026-12-31', 'YEAR'],
    'from=2026-10-01&to=2026-10-31': ['2026-10-01', '2026-10-31', 'RANGE'], '': ['2026-10-01', '2026-10-31', 'MONTH'],
  };
  for (const [qs, [start, end, kind]] of Object.entries(want)) {
    const res = await get(qs ? `?${qs}` : '');
    assert.equal(res.status, 200, `${qs}: ${JSON.stringify(res.body)}`);
    const p = res.body.data.period;
    assert.deepEqual([p.start, p.end, p.asOf, p.kind], [start, end, '2026-10-28', kind], qs);
  }
});

test('m9d702 período anterior termina na data-base do último dia e a posição histórica sai pelo asOf', async () => {
  const sep = await get('?period=2026-09');
  assert.equal(sep.status, 200, JSON.stringify(sep.body));
  assert.equal(sep.body.data.value, '100000.0000');
  assert.deepEqual([sep.body.data.period.asOf, sep.body.data.freshness.historical], ['2026-09-30', true]);
  const past = await get('?asOf=2026-10-20');
  assert.equal(past.body.data.value, '90000.0000', 'asOf devolve o snapshot histórico da data');
  assert.deepEqual([past.body.data.period.start, past.body.data.period.end, past.body.data.period.asOf], ['2026-10-01', '2026-10-31', '2026-10-20']);
  const missing = await get('?asOf=2026-10-21');
  assert.equal(codeOf(missing), 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
});

test('m9d702 período e escopo inválidos devolvem os códigos certos', async () => {
  const bad = ['period=2026-13', 'period=2026-10-31', 'period=abc', 'from=2026-10-31&to=2026-10-01', 'from=2026-10-01', 'to=2026-10-31', 'period=2026-10&month=2026-09',
    'month=2026-1', 'quarter=2026-Q5', 'year=26', 'period=2026-09&asOf=2026-10-05', 'period=2026-10&asOf=2026-09-30'];
  for (const qs of bad) {
    const res = await get(`?${qs}`);
    assert.equal(res.status, 400, qs);
    assert.equal(codeOf(res), 'ANALYTICS_PERIOD_INVALID', qs);
    assert.match(messageOf(res), /^Período inválido\. Informe from\/to em datas de calendário/, qs);
  }
  const future = await get('?period=2026-12');
  assert.equal(codeOf(future), 'ANALYTICS_AS_OF_FUTURE');
  const otherGroup = await get(`?companyId=${env.tenantB.companyId}`);
  assert.equal(otherGroup.status, 404);
  assert.equal(codeOf(otherGroup), 'ANALYTICS_SCOPE_NOT_FOUND');
  assert.equal(messageOf(otherGroup), 'Empresa não encontrada ou sem acesso.');
  const foreign = await srv.call('GET', url(`?companyId=${env.tenantA.companyId}`), { perms: FIN, tenant: 'B' });
  assert.equal(foreign.status, 404, 'a empresa A vista por outro grupo responde 404, nunca 403');
  assert.equal(codeOf(foreign), 'ANALYTICS_SCOPE_NOT_FOUND');
});

test('m9d702 parâmetro desconhecido é rejeitado', async () => {
  const res = await get('?periodo=2026-10');
  assert.equal(res.status, 400);
  assert.equal(codeOf(res), 'ANALYTICS_QUERY_PARAM_UNKNOWN');
  assert.equal(messageOf(res), 'Parâmetro de consulta desconhecido: periodo.');
  const second = await get('?period=2026-10&compare=previous_period');
  assert.equal(messageOf(second), 'Parâmetro de consulta desconhecido: compare.');
  const drill = await get('?page=2');
  assert.equal(codeOf(drill), 'ANALYTICS_QUERY_PARAM_UNKNOWN', 'os parâmetros do detalhe não valem na rota de métrica');
});

test('m9d702 indicador inexistente ou não publicado, permissão e domínio', async () => {
  const none = await srv.call('GET', '/analytics/metrics/fin.nao_existe', { perms: FIN });
  assert.equal(none.status, 404);
  assert.equal(codeOf(none), 'ANALYTICS_METRIC_NOT_FOUND');
  assert.equal(messageOf(none), 'Indicador não encontrado.');
  const other = await e609.publish(env, env.tenantA, { criticality: 'NORMAL', validFrom: '2025-01-01' });
  await env.admin.query("UPDATE analytics.metric_definitions SET status = 'RETIRED' WHERE id = :id", { replacements: { id: other.definition.id } });
  const retired = await srv.call('GET', `/analytics/metrics/${other.code}`, { perms: FIN });
  assert.equal(retired.status, 404, 'indicador fora de PUBLISHED não é servido');
  assert.equal(codeOf(retired), 'ANALYTICS_METRIC_NOT_FOUND');
  const noRead = await get('', { perms: ['finance:read'] });
  assert.equal(noRead.status, 403);
  assert.equal(codeOf(noRead), 'PERMISSION_DENIED');
  assert.equal(messageOf(noRead), 'Permissão ausente: analytics:read.');
  const noDomain = await get('', { perms: ['analytics:read'] });
  assert.equal(noDomain.status, 403, 'métrica de domínio sem a permissão de origem');
  assert.equal(codeOf(noDomain), 'PERMISSION_DENIED');
  assert.equal(messageOf(noDomain), 'Permissão ausente: finance:read.');
});

test('m9d702 dimensão declarada devolve a decomposição e o valor do recorte; não declarada é 400', async () => {
  const all = await get('?dimension=company');
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.data.value, '120000.0000');
  assert.deepEqual(all.body.data.breakdown.items.map((i) => [i.dimensionValue, i.value]), [['filial', '50000.0000'], ['matriz', '70000.0000']]);
  const one = await get('?dimension=company&dimensionValue=matriz');
  assert.equal(one.body.data.value, '70000.0000');
  assert.deepEqual([one.body.data.dimension.code, one.body.data.dimension.value], ['company', 'matriz']);
  for (const qs of ['dimension=regiao', 'dimensionValue=matriz']) {
    const res = await get(`?${qs}`);
    assert.equal(res.status, 400, qs);
    assert.equal(codeOf(res), 'ANALYTICS_DIMENSION_INVALID', qs);
    assert.equal(messageOf(res), 'Dimensão inválida para este indicador.');
  }
  const noSlice = await get('?dimension=company&dimensionValue=nao_existe');
  assert.equal(noSlice.status, 404, 'recorte sem registro na data-base');
  assert.equal(codeOf(noSlice), 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
});

test('m9d702 compareTo devolve variação contra o período anterior e o mesmo período do ano anterior', async () => {
  const prev = await get('?period=2026-10&compareTo=previous_period');
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const v = prev.body.data.variation;
  assert.deepEqual([v.compareTo, v.available, Number(v.previous), Number(v.absolute), v.percent], ['previous_period', true, 100000, 20000, '20.00']);
  assert.deepEqual([v.periodPrevious.startDate, v.periodPrevious.endDate], ['2026-09-01', '2026-09-30']);
  assert.equal(v.percentFormatted, '20,00%');
  const year = await get('?period=2026-10&compareTo=same_period_last_year');
  const y = year.body.data.variation;
  assert.deepEqual([y.compareTo, Number(y.previous), Number(y.absolute), y.percent], ['same_period_last_year', 80000, 40000, '50.00']);
  assert.deepEqual([y.periodPrevious.startDate, y.periodPrevious.endDate], ['2025-10-01', '2025-10-31']);
  const noBase = await get('?period=2026-09&compareTo=previous_period');
  assert.equal(noBase.status, 200, 'sem registro na ponta anterior a leitura continua e a variação diz que não há base');
  assert.deepEqual([noBase.body.data.variation.available, noBase.body.data.variation.absolute], [false, null]);
  const bad = await get('?compareTo=ontem');
  assert.equal(bad.status, 400);
  assert.equal(codeOf(bad), 'ANALYTICS_COMPARE_INVALID');
});

test('m9d702 rota é transação read-only', async () => {
  const { sequelize } = require('../../testHelpers');
  const original = sequelize.query.bind(sequelize);
  const seen = [];
  sequelize.query = async function spy(sql, options) {
    if (options && options.transaction && /FROM analytics\.metric_snapshots/.test(String(sql))) {
      const [[row]] = await original("SELECT current_setting('transaction_read_only') AS ro", { transaction: options.transaction });
      seen.push(row.ro);
    }
    return original(sql, options);
  };
  try {
    const res = await get('?period=2026-10&compareTo=previous_period');
    assert.equal(res.status, 200);
  } finally {
    sequelize.query = original;
  }
  assert.ok(seen.length >= 3, 'leu o valor, a ponta atual e a anterior');
  assert.ok(seen.every((ro) => ro === 'on'), `leitura fora de transação READ ONLY: ${seen}`);
  assert.equal((await srv.call('PATCH', url(''), { perms: FIN })).status, 405, 'a rota não escreve');
});

test('m9d702 leitura de métrica CRITICAL fica no log de acesso', async () => {
  const before = (await env.admin.query("SELECT count(*)::int AS n FROM analytics.access_log WHERE action = 'METRIC_READ' AND resource_code = :c", { replacements: { c: m.code } }))[0][0].n;
  const res = await get('?period=2026-10');
  assert.equal(res.status, 200);
  const rows = (await env.admin.query("SELECT user_id, route, rows_returned FROM analytics.access_log WHERE action = 'METRIC_READ' AND resource_code = :c", { replacements: { c: m.code } }))[0];
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1].route, 'GET /analytics/metrics/:code');
});
