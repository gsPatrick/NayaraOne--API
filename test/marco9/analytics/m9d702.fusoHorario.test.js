'use strict';

// M9-D702 (evidência da M9-D606 §9) — GET /analytics/metrics/fin.free_cash?period=2026-09 pela rota real, com um lançamento às 23:30 de São Paulo de 30/09
// (02:30Z de 01/10) e outro às 00:10 de São Paulo de 01/10 (03:10Z): o de 23:30 é de setembro, o de 00:10 é de outubro. A data-base de setembro é 30/09.
// Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e620 = require('../_helpers/m9d620Env');
const { startServer } = require('../_helpers/m9d702Env');
const readModels = require('../../../src/features/analytics/read-models');
const clock = require('../../../src/features/analytics/metrics/clock');
require('../../../src/features/analytics'); // entrada real do BI: liga os KPIs financeiros ao fim do refresh

const { entry, kpis, inTx, ledger } = e620;
const PERMS = ['analytics:read', 'finance:read'];
let env;
let srv;

/** Recalcula o rm_finance_health da empresa como se fosse `now` (o worker usa o relógio injetado para decidir o dia). */
const refreshAt = (t, now) => inTx(t, { commit: true }, (tx) => readModels.applyEvent({
  id: ledger.uuid(), eventType: 'finance.entry.settled', companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid() }, occurredAt: now, retryCount: 0,
}, tx, { now }));

before(async () => {
  env = await e620.setup();
  clock.setClock(() => e620.NOW);
  srv = await startServer(env, { Y: env.cY });
  const t = env.cY;
  await entry(env, t, { nature: 'RECEIVABLE', amount: '100.00', settled: '2026-10-01T02:30:00.000Z' }); // 23:30 de 30/09 em SP
  await entry(env, t, { nature: 'RECEIVABLE', amount: '40.00', settled: '2026-10-01T03:10:00.000Z' }); // 00:10 de 01/10 em SP
  await refreshAt(t, new Date('2026-10-01T02:45:00.000Z')); // 23:45 de 30/09 em SP: a data-base do read model é 30/09
  await kpis(t, '2026-09-30');
  await e620.refresh(t); // 28/10
  await kpis(t, '2026-10-28');
});
after(async () => { clock.resetClock(); await srv.close(); await e620.teardown(env); });

const get = (qs) => srv.call('GET', `/analytics/metrics/fin.free_cash?${qs}`, { perms: PERMS, tenant: 'Y' });

test('m9d702 period=2026-09 conta só o lançamento das 23:30 de São Paulo; o das 00:10 de 01/10 é de outubro', async () => {
  const sep = await get('period=2026-09');
  assert.equal(sep.status, 200, JSON.stringify(sep.body));
  assert.equal(Number(sep.body.data.value), 100, 'setembro: só o das 23:30');
  assert.deepEqual([sep.body.data.period.start, sep.body.data.period.end, sep.body.data.period.asOf, sep.body.data.period.tz], ['2026-09-01', '2026-09-30', '2026-09-30', 'America/Sao_Paulo']);
  const oct = await get('period=2026-10');
  assert.equal(oct.status, 200, JSON.stringify(oct.body));
  assert.equal(Number(oct.body.data.value), 140, 'outubro, na data-base de 28/10: os dois lançamentos');
  assert.equal(oct.body.data.period.asOf, '2026-10-28');
  assert.equal(sep.body.data.metricCode, 'fin.free_cash');
  assert.equal(sep.body.data.unit, 'BRL');
  assert.equal(sep.body.data.formatted, 'R$ 100,00');
});

test('m9d702 comparação de outubro contra setembro usa os dois fechamentos', async () => {
  const res = await get('period=2026-10&compareTo=previous_period');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const v = res.body.data.variation;
  assert.deepEqual([v.available, Number(v.previous), Number(v.absolute), v.percent], [true, 100, 40, '40.00']);
});
