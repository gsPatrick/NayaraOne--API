'use strict';

// Apoio dos testes da M9-D609 (snapshots diários e freshness): métrica publicada por empresa, snapshot com os instantes controlados, relógio
// fixo e limpeza. Roda SÓ em banco descartável (127.0.0.1). Tudo o que os testes gravam com commit é removido em `teardown`.
const crypto = require('node:crypto');
const sup = require('../../analytics.m9d603.support');
const registry = require('../../../src/features/analytics/metrics');
const store = require('../../../src/features/analytics/metricStore.service');
const clock = require('../../../src/features/analytics/metrics/clock');

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const PERMS = ['analytics:read', 'finance:read', 'crm:opportunities:read', 'legal:read', 'analytics:read:tech'];
const iso = (text) => new Date(text).toISOString();

async function setup() {
  const env = await sup.setup();
  env.catalog = registry.createFormulaCatalog(env.formulaDir);
  env.created = { definitions: [], companies: new Set([env.tenantA.companyId, env.tenantB.companyId]) };
  return env;
}

/** Publica (com commit) uma métrica da empresa. `prefix` define o domínio (fin = FINANCE, crm = CRM, legal = LEGAL, tec = TECH_AI). */
async function publish(env, tenant, { prefix = 'fin', criticality = 'NORMAL', maxStalenessMinutes = 60, validFrom = '2026-01-01' } = {}) {
  const input = sup.metricInput(env, {
    metricCode: `${prefix}.m9d609_${sup.sfx()}`, criticality, validFrom, refreshPolicy: { mode: 'EVENT', maxStalenessMinutes }, unit: 'COUNT',
  });
  const out = await sup.inTx(tenant, { commit: true }, (tx) => registry.publishMetric(input, sup.ctxOf(tenant), tx, { catalog: env.catalog }));
  env.created.definitions.push(out.definition.id);
  return { code: input.metricCode, definition: out.definition, version: out.version };
}

/** Grava (com commit) um snapshot do valor principal da métrica na data-base. */
async function snapshot(tenant, { definition, version, asOfDate, sourceSnapshotAt = null, refreshedAt = null, status = 'OK', value = '100.0000', capturedLate = false }) {
  return sup.inTx(tenant, { commit: true }, async (tx) => {
    await store.enableAnalyticsWriter(tx);
    return store.recordSnapshot({
      companyId: tenant.companyId, groupId: tenant.groupId, metricId: definition.id, metricVersionId: version.id, scopeType: 'COMPANY', scopeId: tenant.companyId,
      periodStart: asOfDate, periodEnd: asOfDate, asOfDate, valueNumeric: value, status, sourceSnapshotAt, refreshedAt, capturedLate,
      sourceRefs: [{ type: 'TABLE', table: 'x', filterHash: sha(`f${asOfDate}`), filterSignature: 'assinatura', count: 3 }], calcHash: sha(`${definition.id}${asOfDate}${value}`),
    }, tx);
  });
}

const readValue = (tenant, code, asOfDate, perms = PERMS) => sup.inTx(tenant, {}, (tx) => registry.readMetricValue(
  { groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms }, { metricCode: code, scopeType: 'COMPANY', scopeId: tenant.companyId, asOfDate }, tx));

const readAsOf = (tenant, code, asOfDate, perms = PERMS) => sup.inTx(tenant, {}, (tx) => registry.readMetricAsOf(
  { groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms }, { metricCode: code, scopeType: 'COMPANY', scopeId: tenant.companyId, asOfDate }, tx));

const at = (text) => { clock.setClock(() => new Date(text)); };

async function teardown(env) {
  clock.resetClock();
  const ids = env.created.definitions;
  const companies = [...env.created.companies];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    if (ids.length) {
      await env.admin.query('DELETE FROM analytics.alert_instances WHERE alert_definition_id IN (SELECT id FROM analytics.alert_definitions WHERE company_id IN (:companies))', { replacements: { companies }, transaction });
      await env.admin.query('DELETE FROM analytics.alert_definitions WHERE company_id IN (:companies)', { replacements: { companies }, transaction });
      await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE metric_id IN (:ids)', { replacements: { ids }, transaction });
      await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE id IN (:ids)', { replacements: { ids }, transaction });
      await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (:ids)', { replacements: { ids }, transaction });
      await env.admin.query('DELETE FROM analytics.metric_definitions WHERE id IN (:ids)', { replacements: { ids }, transaction });
    }
    await env.admin.query('DELETE FROM analytics.snapshot_job_runs WHERE company_id IN (:companies)', { replacements: { companies }, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id IN (:companies) AND (key LIKE 'analytics.freshness.%' OR key LIKE 'analytics.snapshot.%' OR key LIKE 'analytics.alert%')", { replacements: { companies }, transaction });
  });
  await sup.teardown(env);
}

const setSetting = (env, tenant, key, value) => env.admin.query(
  'INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST(:v AS jsonb)) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value',
  { replacements: { g: tenant.groupId, c: tenant.companyId, k: key, v: JSON.stringify(value) } });

module.exports = { PERMS, setup, teardown, publish, snapshot, readValue, readAsOf, at, setSetting, sha, iso, registry, store, clock, sup };
