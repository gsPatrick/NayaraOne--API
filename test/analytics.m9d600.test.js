'use strict';

// M9-D600 — schema "analytics": metric_definitions, metric_versions e metric_snapshots com RLS.
// Roda SÓ em banco descartável (precisa de DATABASE_ADMIN_URL para DDL e para achar a 2ª empresa):
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d600.test.js"
// As transações do usuário passam pelo role nayara_runtime (NOBYPASSRLS), então a RLS é exercitada de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const store = require('../src/features/analytics/metricStore.service');
const migration = require('../migrations/20260101009600-create-analytics-metrics-core');

const UNITS = ['BRL', 'PERCENT', 'COUNT', 'DAYS', 'HOURS', 'MINUTES', 'SECONDS', 'SCORE', 'NUMBER', 'PP', 'BRL_PER_UNIT'];

let admin; // superusuário do cluster descartável (DDL e leitura sem RLS)
let tenantA;
let tenantB;

before(async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL ausente: rode via scripts/withDisposableDb.js (nunca contra o banco compartilhado).');
  assert.match(process.env.DATABASE_ADMIN_URL, /@127\.0\.0\.1:/, 'o destino precisa ser 127.0.0.1');
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  tenantA = await getSeedTenant();
  const [[b]] = await admin.query(
    `SELECT c.id AS "companyId", c.group_id AS "groupId" FROM core.companies c WHERE c.name = 'CI — Empresa Fictícia B' LIMIT 1`
  );
  assert.ok(b, 'empresa B do seed-ci-two-tenants não encontrada');
  const [[u]] = await admin.query(`SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'`);
  tenantB = { groupId: b.groupId, companyId: b.companyId, userId: u.id };
  assert.notEqual(tenantA.groupId, tenantB.groupId);
});

after(async () => {
  await admin.close();
  await sequelize.close();
});

// Transação como a requisição do usuário (role nayara_runtime + GUCs de tenant). writer = worker de BI.
async function inTx(tenant, opts, fn) {
  const { writer = false, commit = false } = opts;
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    if (writer) await store.enableAnalyticsWriter(transaction);
    const result = await fn(transaction);
    if (commit) await transaction.commit();
    else await transaction.rollback();
    return result;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

const ctxOf = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId });
const code = (prefix = 'qa') => `${prefix}.m9d600_${uniqueSuffix()}_${Math.floor(Math.random() * 1000)}`;
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

function versionInput(definitionId, extra = {}) {
  return {
    definitionId,
    expectedVersion: 0,
    formulaId: 'fin.free_cash.v1',
    formulaSemantic: 'Saldo disponível menos obrigações do período.',
    sourceReadModel: 'rm_finance_cash',
    dimensions: ['company'],
    filters: {},
    unit: 'BRL',
    refreshPolicy: { mode: 'SCHEDULE', cron: '0 3 * * *', maxStalenessMinutes: 1440 },
    qualityRule: null,
    valueNature: 'ACTUAL',
    formulaTestHash: hash('dry-run'),
    validFrom: '2026-01-01',
    ...extra,
  };
}

async function newMetric(tx, tenant, { scopeLevel = 'COMPANY', metricCode = code() } = {}) {
  return store.createMetricDefinition(
    {
      scopeLevel,
      groupId: tenant.groupId,
      companyId: scopeLevel === 'COMPANY' ? tenant.companyId : null,
      metricCode,
      name: 'Caixa livre',
      description: 'Teste D600',
      domain: 'FINANCE',
      criticality: 'CRITICAL',
      ownerRole: 'CFO',
    },
    ctxOf(tenant),
    tx
  );
}

function snapshotInput(def, version, tenant, extra = {}) {
  return {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    metricId: def.id,
    metricVersionId: version.id,
    scopeType: 'COMPANY',
    scopeId: tenant.companyId,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    asOfDate: '2026-10-30',
    valueNumeric: '1234.5600',
    status: 'OK',
    sourceSnapshotAt: new Date('2026-10-30T23:00:00Z'),
    readModelVersion: 3,
    sourceRefs: [{ table: 'finance.financial_entries', rows: 12 }],
    calcHash: hash('entrada-1'),
    ...extra,
  };
}

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
