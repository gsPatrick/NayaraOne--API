'use strict';

// Apoio dos testes da M9-D691 (alert engine): métrica com snapshots em instantes controlados, definições de alerta publicadas, regra do Motor de
// Regras e leitura das instâncias. Roda SÓ em banco descartável (127.0.0.1). Tudo o que os testes gravam com commit é removido em `teardown`.
const base = require('./m9d609Env');
const alertDefs = require('../../../src/features/analytics/alertDefinitionStore.service');
const engine = require('../../../src/features/analytics/alerts');

const { sup, store, sha } = base;

async function setup() {
  const env = await base.setup();
  env.rules = [];
  env.events = [];
  env.off = engine.onAlertEvent((e) => env.events.push(e));
  return env;
}

async function teardown(env) {
  env.off();
  if (env.rules.length) {
    await env.admin.query('DELETE FROM core.rule_scopes WHERE rule_version_id IN (SELECT id FROM core.rule_versions WHERE rule_id IN (:ids))', { replacements: { ids: env.rules } });
    await env.admin.query('DELETE FROM core.rule_evaluation_log WHERE rule_version_id IN (SELECT id FROM core.rule_versions WHERE rule_id IN (:ids))', { replacements: { ids: env.rules } });
    await env.admin.query('DELETE FROM analytics.alert_instances WHERE alert_definition_id IN (SELECT id FROM analytics.alert_definitions WHERE rule_id IN (:ids))', { replacements: { ids: env.rules } });
    await env.admin.query('DELETE FROM analytics.alert_definitions WHERE rule_id IN (:ids)', { replacements: { ids: env.rules } });
    await env.admin.query('DELETE FROM core.rule_versions WHERE rule_id IN (:ids)', { replacements: { ids: env.rules } });
    await env.admin.query('DELETE FROM core.rules WHERE id IN (:ids)', { replacements: { ids: env.rules } });
  }
  await env.admin.query('DELETE FROM analytics.read_model_refreshes WHERE read_model = :m', { replacements: { m: engine.REFRESH_LOG_MODEL } });
  await base.teardown(env);
}

/** Grava (com commit) o valor da métrica na data-base: primeira vez cria, as seguintes entram como revisão (o snapshot é imutável). */
async function put(tenant, metric, { value, at, status = 'OK', asOfDate = at.slice(0, 10), dimensionKey = '', sourceAt = at }) {
  return sup.inTx(tenant, { commit: true }, async (tx) => {
    await store.enableAnalyticsWriter(tx);
    const key = { metricId: metric.definition.id, scopeType: 'COMPANY', scopeId: tenant.companyId, asOfDate, dimensionKey };
    const input = {
      companyId: tenant.companyId, groupId: tenant.groupId, metricId: metric.definition.id, metricVersionId: metric.version.id, scopeType: 'COMPANY', scopeId: tenant.companyId,
      dimensionKey, periodStart: asOfDate, periodEnd: asOfDate, asOfDate, valueNumeric: value, status, sourceSnapshotAt: sourceAt, refreshedAt: at,
      sourceRefs: [{ type: 'TABLE', table: 'x', filterHash: sha('f'), filterSignature: 'assinatura', count: 1 }],
      calcHash: sha(`${metric.code}${asOfDate}${value}${at}${status}`),
    };
    const exists = (await store.listSnapshotRevisions(key, tx)).length > 0;
    return exists ? store.recordSnapshotRevision(input, tx) : store.recordSnapshot(input, tx);
  });
}

/** Cria e publica uma definição de alerta da empresa. `threshold` = [operador, valor]; sem ele, `ruleId` (Motor de Regras). */
async function defineAlert(tenant, metric, { code = `al_${sup.sfx()}`, threshold = ['LT', 50000], ruleId = null, severity = 'WARNING', cooldownMinutes = null, autoResolve = {}, createTask = false, scope = {}, ownerRole = 'CFO', pin = null } = {}) {
  return sup.inTx(tenant, { commit: true }, async (tx) => {
    await store.enableAnalyticsWriter(tx);
    const ctx = sup.ctxOf(tenant);
    const row = await alertDefs.createAlertDefinition({
      scopeLevel: 'COMPANY', companyId: tenant.companyId, groupId: tenant.groupId, alertCode: code, metricCode: metric.code, metricVersionPin: pin,
      conditionType: ruleId ? 'RULE_ENGINE' : 'THRESHOLD', threshold: ruleId ? null : { operator: threshold[0], value: threshold[1] }, ruleId, severity, ownerRole,
      cooldownMinutes, autoResolvePolicy: autoResolve, scope, createTask,
    }, ctx, tx);
    return alertDefs.publishAlertDefinition(row.id, ctx, tx);
  });
}

/** Regra do Motor de Regras da empresa com uma condição `value <op> limite`; `published` false deixa a versão em rascunho. */
async function seedRule(env, tenant, { op = '<', limit = 50000, published = true } = {}) {
  const code = `m9d691_${sup.sfx()}`;
  const [[rule]] = await env.admin.query(
    "INSERT INTO core.rules (id, group_id, company_id, code, name, domain) VALUES (gen_random_uuid(), :g, :c, :code, 'Regra QA-M9', 'ANALYTICS') RETURNING id",
    { replacements: { g: tenant.groupId, c: tenant.companyId, code } });
  const [[version]] = await env.admin.query(
    `INSERT INTO core.rule_versions (id, group_id, company_id, rule_id, version_number, condition_ast_json, content_hash, action_json, effective_from, status)
     VALUES (gen_random_uuid(), :g, :c, :r, 1, CAST(:ast AS jsonb), :h, '{}', now() - interval '1 day', :s) RETURNING id`,
    { replacements: { g: tenant.groupId, c: tenant.companyId, r: rule.id, ast: JSON.stringify({ fact: 'value', op, value: limit }), h: sha(code), s: published ? 'PUBLISHED' : 'DRAFT' } });
  await env.admin.query(
    "INSERT INTO core.rule_scopes (id, group_id, company_id, rule_version_id, scope_type, scope_ref_id, precedence) VALUES (gen_random_uuid(), :g, :c, :v, 'GLOBAL', NULL, 7)",
    { replacements: { g: tenant.groupId, c: tenant.companyId, v: version.id } });
  env.rules.push(rule.id);
  return { id: rule.id, code, versionId: version.id };
}

const retireRule = (env, rule) => env.admin.query("UPDATE core.rule_versions SET status = 'RETIRED' WHERE id = :v", { replacements: { v: rule.versionId } });

const evaluate = (tenant, now, options = {}) => engine.evaluateCompanyAlerts({ companyId: tenant.companyId, groupId: tenant.groupId }, { now: new Date(now), seeds: false, ...options });

/** Instâncias da empresa (conexão do superusuário), da mais antiga para a mais nova; filtra por definição quando informada. */
async function instances(env, tenant, definition = null) {
  const [rows] = await env.admin.query(
    `SELECT i.*, d.alert_code FROM analytics.alert_instances i JOIN analytics.alert_definitions d ON d.id = i.alert_definition_id
      WHERE i.company_id = :c AND (CAST(:d AS uuid) IS NULL OR i.alert_definition_id = CAST(:d AS uuid)) ORDER BY i.opened_at, i.created_at`,
    { replacements: { c: tenant.companyId, d: definition ? definition.id : null } });
  return rows;
}

module.exports = { ...base, setup, teardown, put, defineAlert, seedRule, retireRule, evaluate, instances, engine, alertDefs };
