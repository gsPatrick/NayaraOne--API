'use strict';

// M9-D624 — KPI fin.anomalies_open: reprodução a partir dos registros-fonte, risco alto igual ao do Financeiro, qualidade e isolamento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env624 = require('../_helpers/m9d624Env');
const { anomaliesFromSource } = require('../_helpers/m9d624Oracle');
const anomalyCases = require('../../../src/features/finance/anomalyCases.service');

const { anomaly, refresh, kpis, readKpi, dayAt } = env624;
const CODE = 'fin.anomalies_open';
const dim = async (t, key) => String(Number((await readKpi(t, CODE, { dimensionKey: key })).value));
let env;
before(async () => { env = await env624.setup(); });
after(() => env624.teardown(env));

test('m9d624 reproduz fin.anomalies_open a partir dos registros-fonte', async () => {
  const t = env.cX;
  await anomaly(env, t, { risk: 'HIGH', type: 'DUPLICATE', createdAt: dayAt(-4) });
  await anomaly(env, t, { risk: 'CRITICAL', type: 'ROUND_AMOUNT', createdAt: dayAt(-1) });
  await anomaly(env, t, { risk: 'MEDIUM', type: 'DUPLICATE', createdAt: dayAt(-2) });
  await anomaly(env, t, { risk: 'MEDIUM', type: 'DUPLICATE', createdAt: dayAt(0) });
  await anomaly(env, t, { risk: 'LOW', type: 'ROUND_AMOUNT', createdAt: dayAt(-3) });
  await anomaly(env, t, { risk: 'HIGH', status: 'RESOLVED', createdAt: dayAt(-20) }); // resolvida: não conta
  await refresh(t);
  await kpis(t);
  const want = await anomaliesFromSource(env, t, env.asOf);
  assert.deepEqual([want.total, want.byRisk.ALTO, want.byRisk.MEDIO, want.byRisk.BAIXO], ['5', 2, 2, 1], 'exemplo do livro: 5 abertas, 2 ALTO, 2 MEDIO, 1 BAIXO');
  const main = await readKpi(t, CODE);
  assert.equal(Number(main.value), Number(want.total));
  assert.equal(main.status, 'OK');
  assert.equal(main.unit, 'COUNT');
  assert.equal(main.version, 1);
  assert.equal(await dim(t, 'alto'), '2');
  for (const [level, n] of Object.entries(want.byRisk)) assert.equal(await dim(t, `risco:${level}`), String(n), level);
  for (const [type, n] of Object.entries(want.byType)) assert.equal(await dim(t, `tipo:${type}`), String(n), type);
  assert.equal(await dim(t, 'mais_antiga_dias'), want.oldestDays);
});

test('m9d624 o risco alto é o mesmo de countOpenHighRiskAnomalies do Financeiro', async () => {
  const t = env.cX;
  const fromFinance = await env624.inTx(t, {}, (tx) => anomalyCases.countOpenHighRiskAnomalies(t.companyId, tx));
  assert.equal(String(fromFinance), await dim(t, 'alto'));
});

test('m9d624 fin.anomalies_open fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cX;
  await anomaly(env, t, { risk: 'DESCONHECIDO', createdAt: dayAt(-1) });
  await refresh(t);
  await kpis(t);
  const degraded = await readKpi(t, CODE);
  assert.equal(degraded.status, 'DEGRADED');
  assert.equal(degraded.value, null, 'valor nulo');
  assert.equal(await dim(t, 'risco:NAO_CLASSIFICADO'), '1', 'o caso sem nível é contado em NÃO CLASSIFICADO');
  assert.equal(await dim(t, 'alto'), '2', 'o que foi classificado continua correto');
  assert.ok(degraded.revisionNo >= 2, 'a revisão anterior (OK) foi preservada');
});

test('m9d624 isolamento entre empresas no KPI', async () => {
  const [x, y] = [env.cX, env.cY];
  await anomaly(env, y, { risk: 'LOW', createdAt: dayAt(-1) });
  await refresh(y);
  await kpis(y);
  assert.equal(Number((await readKpi(y, CODE)).value), 1, 'a empresa Y só vê a própria anomalia');
  assert.equal((await readKpi(x, CODE)).value, null, 'X segue DEGRADED, sem misturar com Y');
  await assert.rejects(
    env624.inTx(y, {}, (tx) => require('../../../src/features/analytics/metrics').readMetricAsOf(env624.ctxOf(y), { metricCode: CODE, scopeType: 'COMPANY', scopeId: x.companyId, asOfDate: env.asOf }, tx)),
    (e) => e.statusCode === 404, 'o escopo de outra empresa não devolve nada (RLS)'
  );
});
