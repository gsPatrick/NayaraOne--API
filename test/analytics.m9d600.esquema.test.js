'use strict';

// M9-D600 — schema "analytics" (enum, colunas, GRANTs, escopo 404 e restrições entre tabelas).
// Roda SÓ em banco descartável (precisa de DATABASE_ADMIN_URL para DDL e para achar a 2ª empresa):
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d600.esquema.test.js"
// As transações do usuário passam pelo role nayara_runtime (NOBYPASSRLS), então a RLS é exercitada de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { sequelize } = require('./testHelpers');
const store = require('../src/features/analytics/metricStore.service');
const migration = require('../migrations/20260101009600-create-analytics-metrics-core');
const { setupEnv, closeEnv, UNITS, inTx, ctxOf, code, hash, versionInput, newMetric, snapshotInput } = require('./helpers/analyticsM9d600Env');

let admin; // superusuário do cluster descartável (DDL e leitura sem RLS)
let tenantA;
let tenantB;

before(async () => {
  ({ admin, tenantA, tenantB } = await setupEnv());
});

after(async () => {
  await closeEnv(admin);
});

test('m9d600 enum de unit aceita as 11 unidades e recusa outra', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    for (const unit of UNITS) {
      const d = await newMetric(tx, tenantA);
      const v = await store.publishMetricVersion(versionInput(d.id, { unit }), ctxOf(tenantA), tx);
      assert.equal(v.unit, unit);
    }
    assert.equal(UNITS.length, 11);
    const d = await newMetric(tx, tenantA);
    await assert.rejects(
      store.publishMetricVersion(versionInput(d.id, { unit: 'KG' }), ctxOf(tenantA), tx),
      (e) => e.statusCode === 400 && e.code === 'ANALYTICS_METRIC_INVALID'
    );
    // e o banco recusa mesmo sem passar pelo serviço
    await tx.sequelize.query('SAVEPOINT s1', { transaction: tx });
    await assert.rejects(
      sequelize.query(
        `INSERT INTO analytics.metric_versions (company_id, group_id, metric_id, version, formula_id, formula_semantic, unit, refresh_policy, value_nature, valid_from)
         VALUES (:c, :g, :m, 1, 'f', 's', 'KG', '{"mode":"EVENT"}', 'ACTUAL', '2026-01-01')`,
        { replacements: { c: tenantA.companyId, g: tenantA.groupId, m: d.id }, transaction: tx }
      ),
      (e) => e.original?.code === '23514'
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
  });
});

// ------------------------------------------------------------------ 11
test('m9d600 colunas value_nature, formula_test_hash, revision, recalculated e captured_late existem', async () => {
  const [cols] = await admin.query(
    `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'analytics'`
  );
  const has = (t, c) => cols.find((x) => x.table_name === t && x.column_name === c);
  for (const c of ['value_nature', 'formula_test_hash', 'revision', 'unit', 'refresh_policy', 'quality_rule', 'valid_from', 'valid_until', 'published_by', 'published_at', 'change_reason', 'formula_id', 'formula_semantic', 'source_read_model', 'dimensions', 'filters']) {
    assert.ok(has('metric_versions', c), `metric_versions.${c}`);
  }
  assert.equal(has('metric_versions', 'value_nature').is_nullable, 'NO');
  assert.match(has('metric_versions', 'revision').column_default, /0/);
  for (const c of ['recalculated', 'captured_late', 'revision_no', 'calc_hash', 'source_refs', 'source_snapshot_at', 'refreshed_at', 'read_model_version', 'dimension_key', 'value_numeric', 'value_text', 'as_of_date', 'metric_version_id']) {
    assert.ok(has('metric_snapshots', c), `metric_snapshots.${c}`);
  }
  assert.match(has('metric_snapshots', 'revision_no').column_default, /1/);
  assert.match(has('metric_snapshots', 'recalculated').column_default, /false/);
  assert.match(has('metric_snapshots', 'captured_late').column_default, /false/);
  for (const c of ['metric_code', 'name', 'description', 'domain', 'current_version_id', 'status', 'criticality', 'owner_role', 'group_scoped']) {
    assert.ok(has('metric_definitions', c), `metric_definitions.${c}`);
  }
  // value_nature: exatamente uma natureza por versão e só os 4 valores
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    await assert.rejects(
      store.publishMetricVersion(versionInput(d.id, { valueNature: 'OUTRA' }), ctxOf(tenantA), tx),
      (e) => e.statusCode === 400 && e.code === 'ANALYTICS_METRIC_INVALID'
    );
  });
});

// ------------------------------------------------------------------ GRANTs
test('m9d600 GRANTs: nayara_runtime acessa as 3 tabelas e o schema existe só com a role guardada', async () => {
  const [rows] = await admin.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'nayara_runtime' AND table_schema = 'analytics' AND table_name LIKE 'metric_%'`
  );
  for (const t of ['metric_definitions', 'metric_versions', 'metric_snapshots']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.ok(rows.find((r) => r.table_name === t && r.privilege_type === p), `${t} ${p}`);
    }
  }
  assert.match(migration.up.toString(), /pg_roles WHERE rolname = 'nayara_runtime'/);
  assert.ok(randomUUID());
});

// ------------------------------------------------------------------ reabertura: escopo (empresa x grupo x usuário)
const scopeErr = (e) => e.statusCode === 404 && e.code === 'ANALYTICS_SCOPE_NOT_FOUND' && e.message === 'Empresa não encontrada ou sem acesso.';

test('m9d600 empresa de outro grupo ou sem vínculo responde 404 (definição)', async () => {
  const base = { scopeLevel: 'COMPANY', name: 'Caixa livre', domain: 'FINANCE' };
  await inTx(tenantA, { writer: true }, async (tx) => {
    // (1) empresa de outro grupo, informando o grupo dela
    await tx.sequelize.query('SAVEPOINT s1', { transaction: tx });
    await assert.rejects(
      store.createMetricDefinition({ ...base, groupId: tenantB.groupId, companyId: tenantB.companyId, metricCode: code() }, ctxOf(tenantA), tx),
      scopeErr
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
    // (2) empresa A com o grupo da B (par inconsistente)
    await tx.sequelize.query('SAVEPOINT s2', { transaction: tx });
    await assert.rejects(
      store.createMetricDefinition({ ...base, groupId: tenantB.groupId, companyId: tenantA.companyId, metricCode: code() }, ctxOf(tenantA), tx),
      scopeErr
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s2', { transaction: tx });
    // (3) empresa B com o grupo da A
    await tx.sequelize.query('SAVEPOINT s3', { transaction: tx });
    await assert.rejects(
      store.createMetricDefinition({ ...base, groupId: tenantA.groupId, companyId: tenantB.companyId, metricCode: code() }, ctxOf(tenantA), tx),
      scopeErr
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s3', { transaction: tx });
    // (4) métrica de grupo de outro grupo
    await tx.sequelize.query('SAVEPOINT s4', { transaction: tx });
    await assert.rejects(
      store.createMetricDefinition({ scopeLevel: 'GROUP', name: 'Consolidado', domain: 'FINANCE', groupId: tenantB.groupId, metricCode: code() }, ctxOf(tenantA), tx),
      scopeErr
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT s4', { transaction: tx });
    // o caminho legítimo continua aceito
    const ok = await newMetric(tx, tenantA);
    assert.equal(ok.company_id, tenantA.companyId);
    assert.equal(ok.group_id, tenantA.groupId);
  });
});

test('m9d600 empresa de outro grupo ou sem vínculo responde 404 (snapshot)', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await newMetric(tx, tenantA);
    const v1 = await store.publishMetricVersion(versionInput(d.id), ctxOf(tenantA), tx);
    const bad = [
      { companyId: tenantB.companyId, groupId: tenantB.groupId, scopeId: tenantB.companyId },
      { companyId: tenantA.companyId, groupId: tenantB.groupId },
      { companyId: tenantB.companyId, groupId: tenantA.groupId, scopeId: tenantB.companyId },
    ];
    let i = 0;
    for (const extra of bad) {
      i += 1;
      await tx.sequelize.query(`SAVEPOINT b${i}`, { transaction: tx });
      await assert.rejects(store.recordSnapshot(snapshotInput(d, v1, tenantA, extra), tx), scopeErr, `snapshot inválido #${i}`);
      await tx.sequelize.query(`ROLLBACK TO SAVEPOINT b${i}`, { transaction: tx });
    }
    // rebuild com escopo alheio também
    await store.recordSnapshot(snapshotInput(d, v1, tenantA), tx);
    await tx.sequelize.query('SAVEPOINT r1', { transaction: tx });
    await assert.rejects(
      store.recordSnapshotRevision(snapshotInput(d, v1, tenantA, { companyId: tenantB.companyId, groupId: tenantB.groupId, scopeId: tenantB.companyId }), tx),
      (e) => e.statusCode === 404
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT r1', { transaction: tx });
    // snapshot de grupo com grupo alheio
    await tx.sequelize.query('SAVEPOINT g1', { transaction: tx });
    await assert.rejects(
      store.recordSnapshot(snapshotInput(d, v1, tenantA, { scopeType: 'GROUP', companyId: null, groupId: tenantB.groupId, scopeId: tenantB.groupId }), tx),
      scopeErr
    );
    await tx.sequelize.query('ROLLBACK TO SAVEPOINT g1', { transaction: tx });
  });
});

test('m9d600 banco recusa empresa fora do grupo nas 3 tabelas, mesmo sem passar pelo serviço', async () => {
  const t = await admin.transaction(); // superusuário: sem RLS, o gatilho de escopo é a única defesa
  try {
    const ins = async (sql, replacements) => {
      await admin.query('SAVEPOINT x', { transaction: t });
      try {
        await admin.query(sql, { replacements, transaction: t });
        return null;
      } catch (e) {
        return e.original?.code;
      } finally {
        await admin.query('ROLLBACK TO SAVEPOINT x', { transaction: t });
      }
    };
    const defSql = `INSERT INTO analytics.metric_definitions (company_id, group_id, metric_code, name, domain, group_scoped)
                    VALUES (:c, :g, :code, 'x', 'FINANCE', false)`;
    assert.equal(await ins(defSql, { c: tenantA.companyId, g: tenantB.groupId, code: code() }), 'ANA05');
    assert.equal(await ins(defSql, { c: tenantA.companyId, g: null, code: code() }), 'ANA05');
    assert.equal(await ins(defSql, { c: tenantA.companyId, g: tenantA.groupId, code: code() }), null);

    const [[def]] = await admin.query(
      `INSERT INTO analytics.metric_definitions (company_id, group_id, metric_code, name, domain, group_scoped)
       VALUES (:c, :g, :code, 'x', 'FINANCE', false) RETURNING id`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId, code: code() }, transaction: t }
    );
    const verSql = `INSERT INTO analytics.metric_versions (company_id, group_id, metric_id, version, formula_id, formula_semantic, unit, refresh_policy, value_nature, valid_from)
                    VALUES (:c, :g, :m, 1, 'f', 's', 'BRL', '{"mode":"EVENT"}', 'ACTUAL', '2026-01-01')`;
    // a versão que declara empresa/grupo diferentes da definição cai no ANA04 ou no ANA05 (escopo): nunca é aceita
    assert.ok(['ANA04', 'ANA05'].includes(await ins(verSql, { c: tenantB.companyId, g: tenantA.groupId, m: def.id })));
    assert.equal(await ins(verSql, { c: tenantA.companyId, g: tenantA.groupId, m: def.id }), null);
    const [[ver]] = await admin.query(
      `INSERT INTO analytics.metric_versions (company_id, group_id, metric_id, version, formula_id, formula_semantic, unit, refresh_policy, value_nature, valid_from)
       VALUES (:c, :g, :m, 1, 'f', 's', 'BRL', '{"mode":"EVENT"}', 'ACTUAL', '2026-01-01') RETURNING id`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId, m: def.id }, transaction: t }
    );
    const snapSql = `INSERT INTO analytics.metric_snapshots (company_id, group_id, metric_id, metric_version_id, scope_type, scope_id, period_start, period_end, as_of_date, status, calc_hash)
                     VALUES (:c, :g, :m, :v, 'COMPANY', :c, '2026-10-01', '2026-10-31', '2026-10-30', 'OK', :h)`;
    const h = hash('x');
    assert.equal(await ins(snapSql, { c: tenantA.companyId, g: tenantB.groupId, m: def.id, v: ver.id, h }), 'ANA05');
    assert.equal(await ins(snapSql, { c: tenantB.companyId, g: tenantA.groupId, m: def.id, v: ver.id, h }), 'ANA05');
    assert.equal(await ins(snapSql, { c: tenantA.companyId, g: tenantA.groupId, m: def.id, v: ver.id, h }), null);
  } finally {
    await t.rollback();
  }
});

test('m9d600 snapshot recusa versão de outra métrica', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d1 = await newMetric(tx, tenantA);
    const d2 = await newMetric(tx, tenantA);
    await store.publishMetricVersion(versionInput(d1.id), ctxOf(tenantA), tx);
    const v2 = await store.publishMetricVersion(versionInput(d2.id), ctxOf(tenantA), tx);
    await assert.rejects(
      store.recordSnapshot(snapshotInput(d1, v2, tenantA), tx),
      (e) => e.statusCode === 400 && e.code === 'ANALYTICS_METRIC_INVALID'
    );
  });
});
