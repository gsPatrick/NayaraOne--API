'use strict';

// M9-D600 — schema "analytics" (RLS, concorrência, atomicidade e revisões).
// Roda SÓ em banco descartável (precisa de DATABASE_ADMIN_URL para DDL e para achar a 2ª empresa):
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d600.isolamento.test.js"
// As transações do usuário passam pelo role nayara_runtime (NOBYPASSRLS), então a RLS é exercitada de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('./testHelpers');
const store = require('../src/features/analytics/metricStore.service');
const { setupEnv, closeEnv, inTx, ctxOf, code, hash, versionInput, newMetric, snapshotInput } = require('./helpers/analyticsM9d600Env');

let admin; // superusuário do cluster descartável (DDL e leitura sem RLS)
let tenantA;
let tenantB;

before(async () => {
  ({ admin, tenantA, tenantB } = await setupEnv());
});

after(async () => {
  await closeEnv(admin);
});

test('m9d600 RLS: empresa B não lê snapshot, versão nem definição da empresa A', async () => {
  const seed = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    const s = await store.recordSnapshot(snapshotInput(d, v1, tenantA), tx);
    return { d, v1, s };
  });
  const countFor = async (tenant, table, id) =>
    inTx(tenant, {}, async (tx) => {
      const [[r]] = await sequelize.query(`SELECT count(*)::int AS n FROM analytics.${table} WHERE id = :id`, { replacements: { id }, transaction: tx });
      return r.n;
    });
  assert.equal(await countFor(tenantA, 'metric_snapshots', seed.s.id), 1);
  assert.equal(await countFor(tenantB, 'metric_snapshots', seed.s.id), 0);
  assert.equal(await countFor(tenantA, 'metric_versions', seed.v1.id), 1);
  assert.equal(await countFor(tenantB, 'metric_versions', seed.v1.id), 0);
  assert.equal(await countFor(tenantA, 'metric_definitions', seed.d.id), 1);
  assert.equal(await countFor(tenantB, 'metric_definitions', seed.d.id), 0);
  // nem o worker de BI da empresa B escreve na linha da A
  await inTx(tenantB, { writer: true }, async (tx) => {
    const [, meta] = await sequelize.query(`UPDATE analytics.metric_definitions SET name = 'invadida' WHERE id = :id`, { replacements: { id: seed.d.id }, transaction: tx });
    assert.equal(meta.rowCount, 0);
  });
});

test('m9d600 RLS: definição global é legível por todos, a de grupo só pelo grupo, e só o worker escreve nelas', async () => {
  const seed = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const g = await store.createMetricDefinition(
      { scopeLevel: 'GLOBAL', metricCode: code('glob'), name: 'Global', domain: 'CRM', criticality: 'NORMAL' }, ctxOf(tenantA), tx
    );
    const grp = await newMetric(tx, tenantA, { scopeLevel: 'GROUP' });
    return { g, grp };
  });
  const visible = (tenant, id) => inTx(tenant, {}, async (tx) => {
    const [[r]] = await sequelize.query('SELECT count(*)::int AS n FROM analytics.metric_definitions WHERE id = :id', { replacements: { id }, transaction: tx });
    return r.n;
  });
  assert.equal(await visible(tenantA, seed.g.id), 1);
  assert.equal(await visible(tenantB, seed.g.id), 1, 'catálogo global: todos leem');
  assert.equal(await visible(tenantA, seed.grp.id), 1);
  assert.equal(await visible(tenantB, seed.grp.id), 0, 'grupo de outro grupo não enxerga');
  // usuário comum não altera o catálogo global
  await inTx(tenantB, {}, async (tx) => {
    await assert.rejects(
      sequelize.query(`UPDATE analytics.metric_definitions SET name = 'x' WHERE id = :id`, { replacements: { id: seed.g.id }, transaction: tx }).then(([, m]) => {
        if (m.rowCount === 0) throw Object.assign(new Error('0 linhas'), { zero: true });
      }),
      (e) => e.zero === true || e.original?.code === '42501'
    );
  });
});

// ------------------------------------------------------------------ 6
test('m9d600 usuário comum não grava em metric_snapshots', async () => {
  const seed = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    return { d, v1 };
  });
  await inTx(tenantA, {}, async (tx) => {
    await assert.rejects(
      store.recordSnapshot(snapshotInput(seed.d, seed.v1, tenantA), tx),
      (e) => e.statusCode === 403 && e.code === 'ANALYTICS_WRITE_FORBIDDEN' && e.message === 'Somente o processo de atualização do BI grava indicadores.'
    );
  });
  await inTx(tenantA, {}, async (tx) => {
    // o caminho cru também é barrado pela RLS (42501)
    await assert.rejects(
      sequelize.query(
        `INSERT INTO analytics.metric_snapshots (company_id, group_id, metric_id, metric_version_id, scope_type, scope_id, period_start, period_end, as_of_date, status, calc_hash)
         VALUES (:c, :g, :m, :v, 'COMPANY', :c, '2026-10-01', '2026-10-31', '2026-10-30', 'OK', :h)`,
        { replacements: { c: tenantA.companyId, g: tenantA.groupId, m: seed.d.id, v: seed.v1.id, h: hash('x') }, transaction: tx }
      ),
      (e) => e.original?.code === '42501'
    );
  });
  await inTx(tenantA, {}, async (tx) => {
    await assert.rejects(
      store.publishMetricVersion(versionInput(seed.d.id, { expectedVersion: 1, validFrom: '2026-12-01', changeReason: 'x' }), ctxOf(tenantA), tx),
      (e) => e.statusCode === 403 && e.code === 'ANALYTICS_WRITE_FORBIDDEN'
    );
  });
});

// ------------------------------------------------------------------ 7
test('m9d600 duas publicações simultâneas em 2 conexões: uma vence, a outra recebe 409', async () => {
  const d = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const def = await newMetric(tx, tenantA);
    await store.publishMetricVersion(versionInput(def.id), ctxOf(tenantA), tx);
    return def;
  });
  const publish = (formulaId) =>
    inTx(tenantA, { writer: true, commit: true }, (tx) =>
      store.publishMetricVersion(
        versionInput(d.id, { expectedVersion: 1, formulaId, validFrom: '2026-11-01', changeReason: `troca ${formulaId}` }),
        ctxOf(tenantA),
        tx
      )
    );
  const results = await Promise.allSettled([publish('fin.free_cash.vA'), publish('fin.free_cash.vB')]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.code || r.status)));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.statusCode, 409);
  assert.equal(bad[0].reason.code, 'ANALYTICS_METRIC_VERSION_CONFLICT');
  const [rows] = await admin.query('SELECT version FROM analytics.metric_versions WHERE metric_id = :id ORDER BY version', { replacements: { id: d.id } });
  assert.deepEqual(rows.map((r) => r.version), [1, 2]);
});

// ------------------------------------------------------------------ 8
test('m9d600 erro forçado na publicação desfaz tudo', async () => {
  const failingCode = code('qafail');
  const d = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const def = await newMetric(tx, tenantA, { metricCode: failingCode });
    await store.publishMetricVersion(versionInput(def.id), ctxOf(tenantA), tx);
    return def;
  });
  // Falha injetada no ÚLTIMO passo (mover o ponteiro): gatilho temporário só para este teste.
  await admin.query(`
    CREATE OR REPLACE FUNCTION analytics.zz_force_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'falha forçada pelo teste' USING ERRCODE = 'XX999'; END $$;
    CREATE TRIGGER zz_force_fail BEFORE UPDATE ON analytics.metric_definitions
      FOR EACH ROW WHEN (NEW.metric_code LIKE 'qafail.%' AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
      EXECUTE FUNCTION analytics.zz_force_fail();
  `);
  try {
    await assert.rejects(
      inTx(tenantA, { writer: true, commit: true }, (tx) =>
        store.publishMetricVersion(versionInput(d.id, { expectedVersion: 1, validFrom: '2026-11-01', changeReason: 'vai falhar' }), ctxOf(tenantA), tx)
      )
    );
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS zz_force_fail ON analytics.metric_definitions; DROP FUNCTION IF EXISTS analytics.zz_force_fail();');
  }
  const [vers] = await admin.query(`SELECT version, valid_until FROM analytics.metric_versions WHERE metric_id = :id ORDER BY version`, { replacements: { id: d.id } });
  assert.equal(vers.length, 1, 'a v2 não ficou gravada');
  assert.equal(vers[0].valid_until, null, 'a vigência da v1 não foi fechada');
  const [[def]] = await admin.query('SELECT current_version_id FROM analytics.metric_definitions WHERE id = :id', { replacements: { id: d.id } });
  assert.ok(def.current_version_id);
  const [[aud]] = await admin.query(`SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_type = 'analytics.metric_version' AND reason LIKE '%vai falhar%'`);
  assert.equal(aud.n, 0, 'nenhuma auditoria órfã');
});

// ------------------------------------------------------------------ 9
test('m9d600 rebuild grava revision_no + 1 sem atualizar a linha antiga', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    const first = await store.recordSnapshot(snapshotInput(d, v1, tenantA), tx);
    assert.equal(first.revision_no, 1);
    assert.equal(first.recalculated, false);
    const second = await store.recordSnapshotRevision(
      snapshotInput(d, v1, tenantA, { valueNumeric: '2000.0000', calcHash: hash('corrigido') }),
      tx
    );
    assert.equal(second.revision_no, 2);
    assert.equal(second.recalculated, true);
    const rows = await store.listSnapshotRevisions(
      { metricId: d.id, metricVersionId: v1.id, scopeType: 'COMPANY', scopeId: tenantA.companyId, asOfDate: '2026-10-30' },
      tx
    );
    assert.deepEqual(rows.map((r) => r.revision_no), [1, 2]);
    assert.equal(rows[0].value_numeric, '1234.5600', 'a linha antiga permanece intacta');
    assert.equal(rows[0].calc_hash, first.calc_hash);
    const latest = await store.getLatestSnapshot(
      { metricId: d.id, scopeType: 'COMPANY', scopeId: tenantA.companyId, asOfDate: '2026-10-30' },
      tx
    );
    assert.equal(latest.revision_no, 2);
    assert.equal(latest.value_numeric, '2000.0000');
    // terceira revisão
    const third = await store.recordSnapshotRevision(snapshotInput(d, v1, tenantA, { valueNumeric: '3.0000', calcHash: hash('r3') }), tx);
    assert.equal(third.revision_no, 3);
    // UPDATE direto em snapshot é sempre recusado
    await tx.sequelize.query('SAVEPOINT s1', { transaction: tx });
    await assert.rejects(
      sequelize.query(`UPDATE analytics.metric_snapshots SET value_numeric = 1 WHERE id = :id`, { replacements: { id: first.id }, transaction: tx }),
      (e) => e.original?.code === 'ANA03'
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
    // rebuild sem snapshot anterior não existe: precisa ser uma revisão de algo
    await assert.rejects(
      store.recordSnapshotRevision(snapshotInput(d, v1, tenantA, { asOfDate: '2026-09-01', periodStart: '2026-09-01', periodEnd: '2026-09-30' }), tx),
      (e) => e.statusCode === 404 && e.code === 'ANALYTICS_SNAPSHOT_NOT_FOUND'
    );
  });
});

// ------------------------------------------------------------------ 10
