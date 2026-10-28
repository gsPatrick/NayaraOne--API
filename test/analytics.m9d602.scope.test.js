'use strict';

/**
 * M9-D602 (correção da reabertura) — integridade de escopo entre tabelas: a FK ignora a RLS, então o gatilho
 * alert_links_guard recusa instância com definição de outra empresa/grupo e check com refresh de outro escopo.
 * Roda só em banco descartável (scripts/withDisposableDb.js).
 */

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

let admin;
let tenantA;
let tenantB;

before(async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL ausente: rode via scripts/withDisposableDb.js.');
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

async function inTx(tenant, { commit = false } = {}, fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    await metrics.enableAnalyticsWriter(transaction);
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

async function makeDef(tenant, tx) {
  const def = await alertDefs.createAlertDefinition({
    scopeLevel: 'COMPANY', groupId: tenant.groupId, companyId: tenant.companyId, alertCode: `esc_${sfx()}`, metricCode: 'fin.caixa_livre',
    conditionType: 'THRESHOLD', threshold: { operator: 'LT', value: 1 }, severity: 'WARNING', ownerRole: 'DIRETORIA',
  }, ctxOf(tenant), tx);
  return alertDefs.publishAlertDefinition(def.id, ctxOf(tenant), tx);
}

async function rawInstance(tenant, defId, tx) {
  return sequelize.query(
    `INSERT INTO analytics.alert_instances (alert_definition_id, company_id, group_id, fingerprint, severity)
     VALUES (:d, :c, :g, :f, 'WARNING')`,
    { replacements: { d: defId, c: tenant.companyId, g: tenant.groupId, f: fp(sfx()) }, transaction: tx });
}

async function rawCheck(tenant, refreshId, tx) {
  return sequelize.query(
    `INSERT INTO analytics.data_quality_checks (company_id, group_id, check_code, read_model, check_type, status, severity, refresh_id)
     VALUES (:c, :g, 'finance_freshness', 'finance', 'FRESHNESS', 'PASSED', 'INFO', :r)`,
    { replacements: { c: tenant.companyId, g: tenant.groupId, r: refreshId }, transaction: tx });
}

async function expectScope(tx, fn, raw) {
  await sequelize.query('SAVEPOINT exp', { transaction: tx });
  try {
    await assert.rejects(fn(), (err) => {
      if (raw) assert.equal(err.original?.code, 'ANA05');
      else {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'ANALYTICS_SCOPE_NOT_FOUND');
      }
      return true;
    });
  } finally {
    await sequelize.query('ROLLBACK TO SAVEPOINT exp', { transaction: tx });
  }
}
const expectAna05 = (tx, fn) => expectScope(tx, fn, true);
const expect404 = (tx, fn) => expectScope(tx, fn, false);

test('m9d602 escopo: instância com definição de outra empresa e outro grupo é recusada (ANA05)', async () => {
  const defB = await inTx(tenantB, { commit: true }, (tx) => makeDef(tenantB, tx));
  try {
    await inTx(tenantA, {}, async (tx) => {
      await expectAna05(tx, () => rawInstance(tenantA, defB.id, tx));
      await expect404(tx, () => alertInstances.openAlertInstance(
        { alertDefinitionId: defB.id, groupId: tenantA.groupId, companyId: tenantA.companyId, fingerprint: fp(sfx()), severity: 'WARNING' }, ctxOf(tenantA), tx));
    });
    // com a definição da própria empresa, o caminho feliz continua valendo
    await inTx(tenantA, {}, async (tx) => {
      const defA = await makeDef(tenantA, tx);
      await rawInstance(tenantA, defA.id, tx);
    });
  } finally {
    await admin.query('DELETE FROM analytics.alert_definitions WHERE id = :id', { replacements: { id: defB.id } });
  }
});

test('m9d602 escopo: check com refresh de outra empresa e outro grupo é recusado (ANA05)', async () => {
  const refreshB = await inTx(tenantB, { commit: true }, (tx) => refreshes.startRefresh(
    { readModel: 'finance', groupId: tenantB.groupId, companyId: tenantB.companyId, trigger: 'EVENT' }, ctxOf(tenantB), tx));
  try {
    await inTx(tenantA, {}, async (tx) => {
      await expectAna05(tx, () => rawCheck(tenantA, refreshB.id, tx));
      await expect404(tx, () => qualityChecks.recordQualityCheck({
        checkCode: 'finance_freshness', readModel: 'finance', checkType: 'FRESHNESS', status: 'PASSED', severity: 'INFO',
        groupId: tenantA.groupId, companyId: tenantA.companyId, refreshId: refreshB.id,
      }, ctxOf(tenantA), tx));
    });
    await inTx(tenantA, {}, async (tx) => {
      const refreshA = await refreshes.startRefresh({ readModel: 'finance', groupId: tenantA.groupId, companyId: tenantA.companyId, trigger: 'EVENT' }, ctxOf(tenantA), tx);
      await rawCheck(tenantA, refreshA.id, tx);
    });
  } finally {
    await admin.query('DELETE FROM analytics.read_model_refreshes WHERE id = :id', { replacements: { id: refreshB.id } });
  }
});
