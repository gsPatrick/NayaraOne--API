'use strict';

// M9-D602 — alert_definitions, alert_instances, data_quality_checks e read_model_refreshes (schema analytics) com RLS.
// Roda SÓ em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d602.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const metrics = require('../src/features/analytics/metricStore.service');
const alertDefs = require('../src/features/analytics/alertDefinitionStore.service');
const alertInstances = require('../src/features/analytics/alertInstanceStore.service');
const refreshes = require('../src/features/analytics/readModelRefreshStore.service');
const qualityChecks = require('../src/features/analytics/dataQualityCheckStore.service');
const migration = require('../migrations/20260101009602-create-analytics-alerts-quality-refresh');

const TABLES = ['alert_definitions', 'alert_instances', 'data_quality_checks', 'read_model_refreshes'];
let admin;
let tenantA;
let tenantB;

before(async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL ausente: rode via scripts/withDisposableDb.js (nunca contra o banco compartilhado).');
  assert.match(process.env.DATABASE_ADMIN_URL, /@127\.0\.0\.1:/, 'o destino precisa ser 127.0.0.1');
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  tenantA = await getSeedTenant();
  const [[b]] = await admin.query(`SELECT c.id AS "companyId", c.group_id AS "groupId" FROM core.companies c WHERE c.name = 'CI — Empresa Fictícia B' LIMIT 1`);
  const [[u]] = await admin.query(`SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'`);
  tenantB = { groupId: b.groupId, companyId: b.companyId, userId: u.id };
  assert.notEqual(tenantA.groupId, tenantB.groupId);
});

after(async () => {
  await admin.close();
  await sequelize.close();
});

async function inTx(tenant, opts, fn) {
  const { writer = false, commit = false } = opts;
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    if (writer) await metrics.enableAnalyticsWriter(transaction);
    const result = await fn(transaction);
    if (commit) await transaction.commit();
    else await transaction.rollback();
    return result;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

const ctxOf = (t) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId });
const sfx = () => `${uniqueSuffix()}${Math.floor(Math.random() * 1000)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const fp = (s) => createHash('sha256').update(String(s)).digest('hex');

async function expectCode(tx, fn, status, code) {
  await sequelize.query('SAVEPOINT exp', { transaction: tx });
  try {
    await assert.rejects(fn(), (err) => {
      assert.equal(err.statusCode, status, `status ${err.statusCode} ${err.message}`);
      assert.equal(err.code, code);
      return true;
    });
  } finally {
    await sequelize.query('ROLLBACK TO SAVEPOINT exp', { transaction: tx });
  }
}

const defInput = (tenant, extra = {}) => ({
  scopeLevel: 'COMPANY', groupId: tenant.groupId, companyId: tenant.companyId, alertCode: `caixa_baixo_${sfx()}`,
  metricCode: 'fin.caixa_livre', conditionType: 'THRESHOLD', threshold: { operator: 'LT', value: 50000 },
  severity: 'CRITICAL', ownerRole: 'DIRETORIA', createTask: true, autoResolvePolicy: { consecutiveOkEvaluations: 2 }, ...extra,
});

async function createPublishedDef(tx, tenant, extra = {}) {
  const def = await alertDefs.createAlertDefinition(defInput(tenant, extra), ctxOf(tenant), tx);
  return alertDefs.publishAlertDefinition(def.id, ctxOf(tenant), tx);
}

const instInput = (tenant, defId, extra = {}) => ({
  alertDefinitionId: defId, groupId: tenant.groupId, companyId: tenant.companyId, fingerprint: fp(`k${sfx()}`),
  severity: 'CRITICAL', lastValue: 41000, ...extra,
});

async function seedRule(published) {
  const code = `m9d602_${sfx()}`;
  const [[rule]] = await admin.query(
    `INSERT INTO core.rules (id, group_id, company_id, code, name, domain) VALUES (gen_random_uuid(), :g, :c, :code, 'Regra QA', 'ANALYTICS') RETURNING id`,
    { replacements: { g: tenantA.groupId, c: tenantA.companyId, code } });
  await admin.query(
    `INSERT INTO core.rule_versions (id, group_id, company_id, rule_id, version_number, condition_ast_json, content_hash, action_json, effective_from, status)
     VALUES (gen_random_uuid(), :g, :c, :r, 1, '{}', :h, '{}', now(), :s)`,
    { replacements: { g: tenantA.groupId, c: tenantA.companyId, r: rule.id, h: fp(code), s: published ? 'PUBLISHED' : 'DRAFT' } });
  return rule.id;
}

// ------------------------------------------------------------------ 1
test('m9d602 índice único parcial impede dois OPEN com o mesmo fingerprint', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const def = await createPublishedDef(tx, tenantA);
    const input = instInput(tenantA, def.id);
    const first = await alertInstances.openAlertInstance(input, ctxOf(tenantA), tx);
    assert.equal(first.status, 'OPEN');
    assert.equal(first.occurrence_count, 1);
    await expectCode(tx, () => alertInstances.openAlertInstance(input, ctxOf(tenantA), tx), 409, 'ANALYTICS_ALERT_INSTANCE_ACTIVE');
    // o índice é a trava final: o INSERT cru também é recusado pelo banco
    await sequelize.query('SAVEPOINT raw', { transaction: tx });
    await assert.rejects(sequelize.query(
      `INSERT INTO analytics.alert_instances (alert_definition_id, company_id, group_id, fingerprint, status, severity)
       VALUES (:d, :c, :g, :f, 'OPEN', 'CRITICAL')`,
      { replacements: { d: def.id, c: tenantA.companyId, g: tenantA.groupId, f: input.fingerprint }, transaction: tx }),
    (e) => e.original?.code === '23505' && /alert_instances_active_fingerprint_uq/.test(e.original.constraint));
    await sequelize.query('ROLLBACK TO SAVEPOINT raw', { transaction: tx });
    // depois de RESOLVED o mesmo fingerprint pode abrir de novo
    await alertInstances.resolveAlertInstance(first.id, ctxOf(tenantA), tx);
    const again = await alertInstances.openAlertInstance(input, ctxOf(tenantA), tx);
    assert.equal(again.status, 'OPEN');
    assert.notEqual(again.id, first.id);
  });
});

// ------------------------------------------------------------------ 2
test('m9d602 definição sem owner é recusada', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { ownerRole: null }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_OWNER_REQUIRED');
    await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { ownerRole: '   ' }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_OWNER_REQUIRED');
    // o banco também recusa, mesmo sem passar pelo serviço
    await sequelize.query('SAVEPOINT raw', { transaction: tx });
    await assert.rejects(sequelize.query(
      `INSERT INTO analytics.alert_definitions (company_id, group_id, alert_code, metric_code, condition_type, threshold, severity)
       VALUES (:c, :g, 'sem_owner', 'fin.caixa', 'THRESHOLD', '{"operator":"LT","value":1}', 'INFO')`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId }, transaction: tx }),
    (e) => e.original?.code === '23514' && /owner_required/.test(e.original.constraint));
    await sequelize.query('ROLLBACK TO SAVEPOINT raw', { transaction: tx });
    const ok = await alertDefs.createAlertDefinition(defInput(tenantA, { ownerRole: null, ownerUserId: tenantA.userId }), ctxOf(tenantA), tx);
    assert.equal(ok.owner_user_id, tenantA.userId);
  });
});

// ------------------------------------------------------------------ 3
test('m9d602 definição com threshold e rule_id juntos é recusada', async () => {
  const ruleId = await seedRule(true);
  try {
    await inTx(tenantA, { writer: true }, async (tx) => {
      await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { ruleId }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_CONDITION_INVALID');
      await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { conditionType: 'RULE_ENGINE', threshold: null, ruleId: null }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_CONDITION_INVALID');
      await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { threshold: null }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_CONDITION_INVALID');
      await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { threshold: { operator: 'XX', value: 1 } }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_CONDITION_INVALID');
      await sequelize.query('SAVEPOINT raw', { transaction: tx });
      await assert.rejects(sequelize.query(
        `INSERT INTO analytics.alert_definitions (company_id, group_id, alert_code, metric_code, condition_type, threshold, rule_id, severity, owner_role)
         VALUES (:c, :g, 'os_dois', 'fin.caixa', 'THRESHOLD', '{"operator":"LT","value":1}', :r, 'INFO', 'DIRETORIA')`,
        { replacements: { c: tenantA.companyId, g: tenantA.groupId, r: ruleId }, transaction: tx }),
      (e) => e.original?.code === '23514' && /condition_valid/.test(e.original.constraint));
      await sequelize.query('ROLLBACK TO SAVEPOINT raw', { transaction: tx });
      const viaRule = await alertDefs.createAlertDefinition(defInput(tenantA, { conditionType: 'RULE_ENGINE', threshold: null, ruleId }), ctxOf(tenantA), tx);
      assert.equal(viaRule.rule_id, ruleId);
    });
    // regra que não está publicada (só rascunho) não serve
    const draftRule = await seedRule(false);
    await inTx(tenantA, { writer: true }, async (tx) => {
      await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { conditionType: 'RULE_ENGINE', threshold: null, ruleId: draftRule }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_RULE_NOT_PUBLISHED');
    });
  } finally {
    await admin.query(`DELETE FROM analytics.alert_definitions WHERE rule_id IN (SELECT id FROM core.rules WHERE code LIKE 'm9d602\\_%');
      DELETE FROM core.rule_versions WHERE rule_id IN (SELECT id FROM core.rules WHERE code LIKE 'm9d602\\_%');
      DELETE FROM core.rules WHERE code LIKE 'm9d602\\_%'`);
  }
});

// ------------------------------------------------------------------ 4
test('m9d602 coluna/ação de pagamento não existe no schema', async () => {
  const [cols] = await admin.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name IN (${TABLES.map((x) => `'${x}'`).join(',')})`);
  assert.ok(cols.length > 40, 'as 4 tabelas têm colunas');
  const bad = cols.filter((c) => /pay|pagament|pix|boleto|transfer|payout/i.test(c.column_name));
  assert.deepEqual(bad, [], 'nenhuma coluna de pagamento');
  await inTx(tenantA, { writer: true }, async (tx) => {
    await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { action: { type: 'PAYMENT' } }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_ACTION_FORBIDDEN');
    await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { scope: { filtros: { pagamento: { executar: true } } } }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_ACTION_FORBIDDEN');
    await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { autoResolvePolicy: { consecutiveOkEvaluations: 1, payInvoice: true } }), ctxOf(tenantA), tx), 422, 'ANALYTICS_ALERT_ACTION_FORBIDDEN');
    // o banco recusa a chave de pagamento mesmo fora do serviço (qualquer profundidade)
    await sequelize.query('SAVEPOINT raw', { transaction: tx });
    await assert.rejects(sequelize.query(
      `INSERT INTO analytics.alert_definitions (company_id, group_id, alert_code, metric_code, condition_type, threshold, severity, owner_role, scope)
       VALUES (:c, :g, 'paga', 'fin.caixa', 'THRESHOLD', '{"operator":"LT","value":1}', 'INFO', 'DIRETORIA', '{"a":[{"Payment":1}]}')`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId }, transaction: tx }),
    (e) => e.original?.code === 'ANA12');
    await sequelize.query('ROLLBACK TO SAVEPOINT raw', { transaction: tx });
    // campos normais com nomes parecidos não são bloqueados (payload, prefix)
    const ok = await alertDefs.createAlertDefinition(defInput(tenantA, { scope: { payload: 1, prefix: 'x' } }), ctxOf(tenantA), tx);
    assert.ok(ok.id);
  });
});

// ------------------------------------------------------------------ 5
test('m9d602 RLS nas 4 tabelas', async () => {
  const ids = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const def = await createPublishedDef(tx, tenantA);
    const inst = await alertInstances.openAlertInstance(instInput(tenantA, def.id), ctxOf(tenantA), tx);
    const refresh = await refreshes.startRefresh({ readModel: 'finance', groupId: tenantA.groupId, companyId: tenantA.companyId, trigger: 'EVENT' }, ctxOf(tenantA), tx);
    const check = await qualityChecks.recordQualityCheck({
      checkCode: 'finance_freshness', readModel: 'finance', checkType: 'FRESHNESS', status: 'PASSED', severity: 'WARNING',
      groupId: tenantA.groupId, companyId: tenantA.companyId, refreshId: refresh.id, affectedMetricCodes: ['fin.caixa_livre'],
    }, ctxOf(tenantA), tx);
    return { alert_definitions: def.id, alert_instances: inst.id, read_model_refreshes: refresh.id, data_quality_checks: check.id };
  });
  try {
    await inTx(tenantB, { writer: true }, async (tx) => {
      for (const table of TABLES) {
        const [rows] = await sequelize.query(`SELECT id FROM analytics.${table} WHERE id = :id`, { replacements: { id: ids[table] }, transaction: tx });
        assert.equal(rows.length, 0, `${table}: empresa B não lê a linha da A`);
        const [, meta] = await sequelize.query(`UPDATE analytics.${table} SET created_at = now() WHERE id = :id`, { replacements: { id: ids[table] }, transaction: tx }).catch(() => [null, { rowCount: 0 }]);
        assert.equal(meta.rowCount, 0, `${table}: empresa B não altera a linha da A`);
      }
    });
    await inTx(tenantA, {}, async (tx) => {
      for (const table of TABLES) {
        const [rows] = await sequelize.query(`SELECT id FROM analytics.${table} WHERE id = :id`, { replacements: { id: ids[table] }, transaction: tx });
        assert.equal(rows.length, 1, `${table}: a dona lê`);
      }
      // sem a GUC do worker, escrita é recusada nas quatro (403)
      await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA), ctxOf(tenantA), tx), 403, 'ANALYTICS_WRITE_FORBIDDEN');
      await expectCode(tx, () => refreshes.startRefresh({ readModel: 'finance', groupId: tenantA.groupId, companyId: tenantA.companyId, trigger: 'EVENT' }, ctxOf(tenantA), tx), 403, 'ANALYTICS_WRITE_FORBIDDEN');
      await sequelize.query('SAVEPOINT raw', { transaction: tx });
      await assert.rejects(sequelize.query(`DELETE FROM analytics.alert_instances WHERE id = :id`, { replacements: { id: ids.alert_instances }, transaction: tx }).then(([, m]) => { if (m.rowCount === 0) throw Object.assign(new Error('x'), { original: { code: '42501' } }); }), (e) => e.original?.code === '42501');
      await sequelize.query('ROLLBACK TO SAVEPOINT raw', { transaction: tx });
    });
    // empresa de outro grupo: 404, nunca 403
    await inTx(tenantA, { writer: true }, async (tx) => {
      await expectCode(tx, () => alertDefs.createAlertDefinition(defInput(tenantA, { companyId: tenantB.companyId, groupId: tenantB.groupId }), ctxOf(tenantA), tx), 404, 'ANALYTICS_SCOPE_NOT_FOUND');
      await expectCode(tx, () => refreshes.startRefresh({ readModel: 'finance', groupId: tenantB.groupId, companyId: tenantB.companyId, trigger: 'EVENT' }, ctxOf(tenantA), tx), 404, 'ANALYTICS_SCOPE_NOT_FOUND');
    });
  } finally {
    await admin.query(`DELETE FROM analytics.data_quality_checks WHERE id = :q; DELETE FROM analytics.read_model_refreshes WHERE id = :r;
      DELETE FROM analytics.alert_instances WHERE id = :i; DELETE FROM analytics.alert_definitions WHERE id = :d;`,
    { replacements: { q: ids.data_quality_checks, r: ids.read_model_refreshes, i: ids.alert_instances, d: ids.alert_definitions } });
  }
});

// ------------------------------------------------------------------ extras do livro (§16 e cenários positivos)
test('m9d602 definição publicada é carregável pelo alert engine e instância segue OPEN, ACKNOWLEDGED, RESOLVED', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const draft = await alertDefs.createAlertDefinition(defInput(tenantA, { cooldownMinutes: null }), ctxOf(tenantA), tx);
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.cooldown_minutes, null, 'nulo = vale o padrão da severidade (D691)');
    const before = await alertDefs.listPublishedAlertDefinitions(ctxOf(tenantA), tx);
    assert.ok(!before.some((d) => d.id === draft.id), 'rascunho não é carregado');
    const published = await alertDefs.publishAlertDefinition(draft.id, ctxOf(tenantA), tx);
    assert.equal(published.status, 'PUBLISHED');
    const loaded = await alertDefs.listPublishedAlertDefinitions(ctxOf(tenantA), tx);
    assert.ok(loaded.some((d) => d.id === draft.id));
    const inst = await alertInstances.openAlertInstance(instInput(tenantA, draft.id), ctxOf(tenantA), tx);
    const seen = await alertInstances.recordRepeatedEvaluation(inst.id, { lastValue: 40000 }, ctxOf(tenantA), tx);
    assert.equal(seen.occurrence_count, 2);
    const acked = await alertInstances.acknowledgeAlertInstance(inst.id, ctxOf(tenantA), tx);
    assert.equal(acked.status, 'ACKNOWLEDGED');
    assert.equal(acked.acknowledged_by, tenantA.userId);
    const done = await alertInstances.resolveAlertInstance(inst.id, ctxOf(tenantA), tx);
    assert.equal(done.status, 'RESOLVED');
    assert.equal(done.resolved_reason, 'CONDITION_NORMALIZED');
    await expectCode(tx, () => alertInstances.acknowledgeAlertInstance(inst.id, ctxOf(tenantA), tx), 409, 'ANALYTICS_ALERT_INSTANCE_FINAL');
    await sequelize.query('SAVEPOINT raw', { transaction: tx });
    await assert.rejects(sequelize.query(`UPDATE analytics.alert_instances SET status = 'OPEN', resolved_at = NULL, resolved_reason = NULL WHERE id = :id`, { replacements: { id: inst.id }, transaction: tx }), (e) => e.original?.code === 'ANA11');
    await sequelize.query('ROLLBACK TO SAVEPOINT raw', { transaction: tx });
  });
});

test('m9d602 reconhecimento roda na transação do usuário sem a GUC do worker, só OPEN para ACKNOWLEDGED', async () => {
  const instId = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const def = await createPublishedDef(tx, tenantA);
    return (await alertInstances.openAlertInstance(instInput(tenantA, def.id), ctxOf(tenantA), tx)).id;
  });
  try {
    await inTx(tenantA, {}, async (tx) => {
      // sem writer: não resolve, não muda valor, só reconhece
      await sequelize.query('SAVEPOINT s1', { transaction: tx });
      await assert.rejects(sequelize.query(`UPDATE analytics.alert_instances SET last_value = 1 WHERE id = :id`, { replacements: { id: instId }, transaction: tx }), (e) => ['ANA11', '42501'].includes(e.original?.code));
      await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
      await expectCode(tx, () => alertInstances.resolveAlertInstance(instId, ctxOf(tenantA), tx), 403, 'ANALYTICS_WRITE_FORBIDDEN');
      const acked = await alertInstances.acknowledgeAlertInstance(instId, ctxOf(tenantA), tx);
      assert.equal(acked.status, 'ACKNOWLEDGED');
      assert.equal(acked.acknowledged_by, tenantA.userId);
    });
  } finally {
    await admin.query(`DELETE FROM analytics.alert_instances WHERE id = :id`, { replacements: { id: instId } });
    await admin.query(`DELETE FROM analytics.alert_definitions WHERE alert_code LIKE 'caixa\\_baixo\\_%' AND NOT EXISTS (SELECT 1 FROM analytics.alert_instances i WHERE i.alert_definition_id = alert_definitions.id)`);
  }
});

test('m9d602 cada refresh grava um registro de diário e seus checks', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const r = await refreshes.startRefresh({ readModel: 'finance', groupId: tenantA.groupId, companyId: tenantA.companyId, trigger: 'SCHEDULE', version: 3 }, ctxOf(tenantA), tx);
    assert.equal(r.status, 'RUNNING');
    assert.equal(r.finished_at, null);
    const chk = await qualityChecks.recordQualityCheck({
      checkCode: 'finance_rows', readModel: 'finance', checkType: 'ROW_COUNT_RANGE', status: 'FAILED', severity: 'CRITICAL',
      groupId: tenantA.groupId, companyId: tenantA.companyId, refreshId: r.id, expected: { min: 1 }, observed: { rows: 0 },
    }, ctxOf(tenantA), tx);
    assert.equal(chk.refresh_id, r.id);
    assert.deepEqual(chk.affected_metric_codes, []);
    const done = await refreshes.finishRefresh(r.id, { status: 'DEGRADED', rowsUpserted: 12, lastSourceEventId: 'ev-9', sourceSnapshotAt: new Date().toISOString() }, ctxOf(tenantA), tx);
    assert.equal(done.status, 'DEGRADED');
    assert.equal(done.rows_upserted, 12);
    assert.ok(done.duration_ms >= 0);
    const list = await qualityChecks.listChecksForRefresh(r.id, tx);
    assert.equal(list.length, 1);
    await expectCode(tx, () => refreshes.startRefresh({ readModel: 'finance', groupId: tenantA.groupId, companyId: tenantA.companyId, trigger: 'POR_EVENTO' }, ctxOf(tenantA), tx), 400, 'ANALYTICS_REFRESH_INVALID');
    await expectCode(tx, () => refreshes.finishRefresh(r.id, { status: 'FAILED' }, ctxOf(tenantA), tx), 400, 'ANALYTICS_REFRESH_INVALID');
    await expectCode(tx, () => qualityChecks.recordQualityCheck({ checkCode: 'x', readModel: 'finance', checkType: 'OUTRO', status: 'PASSED', severity: 'INFO', groupId: tenantA.groupId, companyId: tenantA.companyId }, ctxOf(tenantA), tx), 400, 'ANALYTICS_QUALITY_CHECK_INVALID');
  });
});

// ------------------------------------------------------------------ 6
test('m9d602 migration idempotente e reversível', async () => {
  const qi = { sequelize: { query: (sql) => admin.query(sql, { transaction: qi.tx }) } };
  const t = await admin.transaction();
  qi.tx = t;
  try {
    await migration.up(qi);
    await migration.up(qi);
    await migration.down(qi);
    const [gone] = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name IN (${TABLES.map((x) => `'${x}'`).join(',')})`, { transaction: t });
    assert.equal(gone[0].n, 0, 'down remove as 4 tabelas');
    const [[core]] = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name IN ('metric_definitions','dashboard_definitions')`, { transaction: t });
    assert.equal(core.n, 2, 'o down não toca nas tabelas da D600/D601');
    await migration.up(qi);
    const [tabs] = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS pol
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname IN (${TABLES.map((x) => `'${x}'`).join(',')})`, { transaction: t });
    assert.equal(tabs.length, 4);
    for (const r of tabs) assert.ok(r.relrowsecurity && r.relforcerowsecurity && r.pol === 4, `${r.relname} RLS/FORCE/4 políticas`);
  } finally { await t.rollback(); }
});

test('m9d602 GRANTs só para nayara_runtime e nada para PUBLIC', async () => {
  const [rows] = await admin.query(
    `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'analytics' AND table_name IN (${TABLES.map((x) => `'${x}'`).join(',')})`);
  assert.ok(!rows.some((r) => r.grantee === 'PUBLIC'));
  for (const table of TABLES) {
    const privs = rows.filter((r) => r.table_name === table && r.grantee === 'nayara_runtime').map((r) => r.privilege_type);
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.ok(privs.includes(p), `${table} ${p}`);
  }
});

test('m9d602 snapshot inexistente na instância é recusado (sem FK por causa do down da D600)', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const def = await createPublishedDef(tx, tenantA);
    await expectCode(tx, () => alertInstances.openAlertInstance(instInput(tenantA, def.id, { metricSnapshotId: '00000000-0000-4000-8000-000000000001' }), ctxOf(tenantA), tx), 404, 'ANALYTICS_SNAPSHOT_NOT_FOUND');
  });
});
