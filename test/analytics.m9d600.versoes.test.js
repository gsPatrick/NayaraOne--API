'use strict';

// M9-D600 — schema "analytics" (versões, vigência e snapshots duplicados).
// Roda SÓ em banco descartável (precisa de DATABASE_ADMIN_URL para DDL e para achar a 2ª empresa):
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d600.versoes.test.js"
// As transações do usuário passam pelo role nayara_runtime (NOBYPASSRLS), então a RLS é exercitada de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('./testHelpers');
const store = require('../src/features/analytics/metricStore.service');
const migration = require('../migrations/20260101009600-create-analytics-metrics-core');
const { setupEnv, closeEnv, inTx, ctxOf, hash, versionInput, newMetric, snapshotInput } = require('./helpers/analyticsM9d600Env');

let admin; // superusuário do cluster descartável (DDL e leitura sem RLS)
let tenantA;

before(async () => {
  ({ admin, tenantA } = await setupEnv());
});

after(async () => {
  await closeEnv(admin);
});

// ------------------------------------------------------------------ 1
test('m9d600 migration cria schema e tabelas e roda duas vezes', async () => {
  const qi = {
    sequelize: { query: (sql) => admin.query(sql, { transaction: qi.tx }) },
  };
  const t = await admin.transaction();
  qi.tx = t;
  try {
    await migration.up(qi); // 2ª execução em cima do que o migrate já criou: idempotente
    await migration.up(qi);
    await migration.down(qi);
    const [after1] = await admin.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name IN ('metric_definitions','metric_versions','metric_snapshots')`,
      { transaction: t }
    );
    assert.equal(after1[0].n, 0, 'down remove as 3 tabelas');
    await migration.up(qi);
    const [tabs] = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'analytics' AND c.relname IN ('metric_definitions','metric_versions','metric_snapshots') ORDER BY 1`,
      { transaction: t }
    );
    assert.equal(tabs.length, 3);
    for (const row of tabs) {
      assert.equal(row.relrowsecurity, true, `${row.relname} RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} FORCE RLS`);
    }
  } finally {
    await t.rollback();
  }
  // o rollback devolve o estado original: tabelas continuam lá
  const [[{ n }]] = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name LIKE 'metric_%'`);
  assert.ok(n >= 3);
});

// ------------------------------------------------------------------ cenário positivo + exemplo numérico
test('m9d600 publicar cria v1, liga current_version_id e a v2 fecha a vigência da v1', async () => {
  const def = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    assert.equal(v1.version, 1);
    const [[row]] = await sequelize.query('SELECT current_version_id, status FROM analytics.metric_definitions WHERE id = :id', {
      replacements: { id: d.id }, transaction: tx,
    });
    assert.equal(row.current_version_id, v1.id);
    assert.equal(row.status, 'PUBLISHED');
    return { d, v1 };
  });
  const out = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const v2 = await store.publishMetricVersion(
      versionInput(def.d.id, { expectedVersion: 1, formulaId: 'fin.free_cash.v2', validFrom: '2026-11-01', changeReason: 'Passa a descontar a reserva' }),
      ctxOf(tenantA),
      tx
    );
    assert.equal(v2.version, 2);
    const [[old]] = await sequelize.query('SELECT to_char(valid_until, \'YYYY-MM-DD\') AS vu FROM analytics.metric_versions WHERE id = :id', {
      replacements: { id: def.v1.id }, transaction: tx,
    });
    assert.equal(old.vu, '2026-11-01');
    // snapshot de outubro usa a v1, de novembro a v2
    const snapOct = await store.recordSnapshot(snapshotInput(def.d, def.v1, tenantA, { asOfDate: '2026-10-30' }), tx);
    const snapNov = await store.recordSnapshot(
      snapshotInput(def.d, v2, tenantA, { periodStart: '2026-11-01', periodEnd: '2026-11-30', asOfDate: '2026-11-02', calcHash: hash('nov') }),
      tx
    );
    const atOct = await store.getMetricVersionAt(def.d.id, '2026-10-15', tx);
    const atNov = await store.getMetricVersionAt(def.d.id, '2026-11-15', tx);
    assert.equal(atOct.id, def.v1.id);
    assert.equal(atNov.id, v2.id);
    assert.equal(snapOct.metric_version_id, def.v1.id);
    assert.equal(snapNov.metric_version_id, v2.id);
    // auditoria com antes e depois
    const [[aud]] = await sequelize.query(
      `SELECT action, after_json FROM audit.audit_log WHERE entity_type = 'analytics.metric_version' AND entity_id = :id`,
      { replacements: { id: v2.id }, transaction: tx }
    );
    assert.equal(aud.action, 'analytics.metric.publish');
    return true;
  });
  assert.ok(out);
});

test('m9d600 publicar com valid_from anterior ao da versão vigente é recusado com 409 OVERLAP', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    await store.publishMetricVersion(versionInput(d.id, { validFrom: '2026-05-01' }), ctxOf(tenantA), tx);
    await assert.rejects(
      store.publishMetricVersion(versionInput(d.id, { expectedVersion: 1, validFrom: '2026-04-01', changeReason: 'x' }), ctxOf(tenantA), tx),
      (e) => e.statusCode === 409 && e.code === 'ANALYTICS_METRIC_VERSION_OVERLAP'
    );
  });
});

// ------------------------------------------------------------------ 2
test('m9d600 UPDATE em metric_versions publicada é recusado pelo gatilho', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    await tx.sequelize.query('SAVEPOINT s1', { transaction: tx });
    let err;
    try {
      await sequelize.query(`UPDATE analytics.metric_versions SET formula_id = 'x' WHERE id = :id`, { replacements: { id: v1.id }, transaction: tx });
    } catch (e) { err = e; }
    assert.ok(err, 'o UPDATE precisa falhar');
    assert.equal(err.original?.code, 'ANA01');
    const mapped = store.translateAnalyticsDbError(err);
    assert.equal(mapped.statusCode, 409);
    assert.equal(mapped.code, 'ANALYTICS_METRIC_VERSION_IMMUTABLE');
    assert.equal(mapped.message, 'Versão publicada não pode ser alterada. Publique uma nova versão.');
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
    const [[row]] = await sequelize.query('SELECT formula_id FROM analytics.metric_versions WHERE id = :id', { replacements: { id: v1.id }, transaction: tx });
    assert.equal(row.formula_id, 'fin.free_cash.v1', '0 linhas alteradas');

    // DELETE também é recusado
    await tx.sequelize.query('SAVEPOINT s2', { transaction: tx });
    await assert.rejects(
      sequelize.query('DELETE FROM analytics.metric_versions WHERE id = :id', { replacements: { id: v1.id }, transaction: tx }),
      (e) => e.original?.code === 'ANA01'
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s2', { transaction: tx });
  });
});

// ------------------------------------------------------------------ 3
test('m9d600 vigências sobrepostas são recusadas', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    // v2 inserida "na mão" sem fechar a vigência da v1: o EXCLUDE recusa
    await tx.sequelize.query('SAVEPOINT s1', { transaction: tx });
    let err;
    try {
      await sequelize.query(
        `INSERT INTO analytics.metric_versions (company_id, group_id, metric_id, version, formula_id, formula_semantic, unit, refresh_policy, value_nature, valid_from, change_reason)
         VALUES (:c, :g, :m, 2, 'f2', 'sem', 'BRL', '{"mode":"EVENT"}', 'ACTUAL', '2026-06-01', 'motivo')`,
        { replacements: { c: tenantA.companyId, g: tenantA.groupId, m: d.id }, transaction: tx }
      );
    } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.original?.code, '23P01');
    const mapped = store.translateAnalyticsDbError(err);
    assert.equal(mapped.statusCode, 409);
    assert.equal(mapped.code, 'ANALYTICS_METRIC_VERSION_OVERLAP');
    assert.equal(mapped.message, 'Já existe versão vigente neste intervalo.');
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
    assert.ok(v1.id);
  });
});

test('m9d600 numeração de versão não aceita buracos nem versão 2 sem change_reason', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    await assert.rejects(
      store.publishMetricVersion(versionInput(d.id, { expectedVersion: 1, validFrom: '2026-12-01' }), ctxOf(tenantA), tx),
      (e) => e.statusCode === 400 && e.code === 'ANALYTICS_METRIC_INVALID'
    );
    await tx.sequelize.query('SAVEPOINT s1', { transaction: tx });
    await assert.rejects(
      sequelize.query(
        `INSERT INTO analytics.metric_versions (company_id, group_id, metric_id, version, formula_id, formula_semantic, unit, refresh_policy, value_nature, valid_from, change_reason)
         VALUES (:c, :g, :m, 3, 'f3', 'sem', 'BRL', '{"mode":"EVENT"}', 'ACTUAL', '2027-06-01', 'buraco')`,
        { replacements: { c: tenantA.companyId, g: tenantA.groupId, m: d.id }, transaction: tx }
      ),
      (e) => e.original?.code === 'ANA02'
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
  });
});

// ------------------------------------------------------------------ 4
test('m9d600 snapshot duplicado é recusado', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    await store.recordSnapshot(snapshotInput(d, v1, tenantA), tx);
    await tx.sequelize.query('SAVEPOINT s1', { transaction: tx });
    let err;
    try { await store.recordSnapshot(snapshotInput(d, v1, tenantA), tx); } catch (e) { err = e; }
    assert.ok(err, 'segundo INSERT recusado');
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, 'ANALYTICS_SNAPSHOT_DUPLICATE');
    assert.equal(err.cause?.original?.code ?? err.cause?.parent?.code, '23505');
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
  });
});

// ------------------------------------------------------------------ 5
