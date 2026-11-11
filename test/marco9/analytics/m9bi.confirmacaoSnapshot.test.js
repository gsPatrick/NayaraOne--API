'use strict';

// DI-BI-2 — um indicador cujo número não muda não envelhece enquanto a fonte for relida. O snapshot é imutável (M9-D600) e o recálculo com o mesmo valor, status e hash
// não grava revisão; antes, a freshness contava do PRIMEIRO cálculo e o indicador saía "Dado antigo" (EXPIRED, sem valor) mesmo com a fonte relida a cada passada
// (homologação, 10/11: integrações, autenticação, bloqueios e chamadas bloqueadas com "última atualização 02:50"). Agora cada releitura confirma o snapshot.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d680Env');
const { collectCriticalFreshness } = require('../../../src/features/analytics/metrics/freshness.signal');

let env;
const CODE = 'tec.integration_errors'; // limite de 5 minutos (EXPIRED acima de 20), CRITICAL
const later = (minutes) => new Date(kit.NOW.getTime() + minutes * 60000);
const count = async (sql, t) => (await env.admin.query(sql, { replacements: { c: t.companyId, code: CODE } }))[0][0].n;
const SNAPSHOTS = `SELECT count(*)::int AS n FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
  WHERE s.company_id = :c AND d.metric_code = :code`;
const critical = (t) => kit.inTx(t, {}, (tx) => collectCriticalFreshness({ companyId: t.companyId, groupId: t.groupId }, tx, { now: kit.clock.now() }))
  .then((list) => list.find((i) => i.metricCode === CODE));

before(async () => {
  env = await kit.setup();
  await kit.seedSources(env, env.cX);
  await kit.hourlyProbes(env);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9bi confirmação: sem releitura da fonte o número envelhece até EXPIRED e sai sem valor', async () => {
  const fresh = await kit.readKpi(env.cX, CODE);
  assert.equal(fresh.freshness.state, 'FRESH');
  assert.notEqual(fresh.value, null);
  kit.clock.setClock(later(30));
  try {
    const old = await kit.readKpi(env.cX, CODE);
    assert.deepEqual([old.freshness.state, old.status, old.value], ['EXPIRED', 'DEGRADED', null], '30 minutos sem releitura: acima de 4 x 5 minutos');
    assert.equal((await critical(env.cX)).state, 'EXPIRED');
  } finally {
    kit.clock.setClock(kit.NOW);
  }
});

test('m9bi confirmação: a releitura que chega ao mesmo número confirma o snapshot sem gravar revisão e o indicador continua fresco', async () => {
  const first = await kit.readKpi(env.cX, CODE);
  const before = await count(SNAPSHOTS, env.cX);
  kit.clock.setClock(later(30));
  try {
    await kit.runSchedule(env.cX, later(30));
    await kit.kpis(env.cX);
    const read = await kit.readKpi(env.cX, CODE);
    assert.equal(await count(SNAPSHOTS, env.cX), before, 'snapshot imutável: nenhuma revisão nova para o mesmo número');
    assert.deepEqual([read.value, read.revisionNo, read.status], [first.value, first.revisionNo, first.status]);
    assert.equal(read.freshness.state, 'FRESH');
    assert.equal(new Date(read.freshness.sourceSnapshotAt).toISOString(), later(30).toISOString(), 'a idade conta da leitura que confirmou');
    assert.equal(new Date(read.freshness.recordedSourceAt).toISOString(), new Date(first.sourceSnapshotAt).toISOString(), 'o instante do snapshot gravado continua visível');
    assert.equal(new Date(read.sourceSnapshotAt).toISOString(), new Date(first.sourceSnapshotAt).toISOString(), 'o registro do snapshot não muda');
    assert.equal((await critical(env.cX)).state, 'FRESH', 'o alerta técnico de freshness crítica usa a mesma confirmação');
    const [[c]] = await env.admin.query(`SELECT c.confirmations, c.source_confirmed_at FROM analytics.metric_snapshot_confirmations c JOIN analytics.metric_definitions d ON d.id = c.metric_id
      WHERE c.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code: CODE } });
    assert.ok(c.confirmations >= 1);
    assert.equal(new Date(c.source_confirmed_at).toISOString(), later(30).toISOString());
  } finally {
    kit.clock.setClock(kit.NOW);
  }
});

test('m9bi confirmação: leitura de dia passado continua mostrando o registro como foi gravado', async () => {
  kit.clock.setClock(new Date('2026-10-29T15:00:00Z'));
  try {
    const read = await kit.readKpi(env.cX, CODE);
    assert.equal(read.historical, true);
    assert.equal(read.freshness.recordedSourceAt, undefined, 'a confirmação só vale para hoje');
    assert.equal(new Date(read.freshness.sourceSnapshotAt).toISOString(), new Date(read.sourceSnapshotAt).toISOString());
  } finally {
    kit.clock.setClock(kit.NOW);
  }
});
