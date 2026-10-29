'use strict';

// Apoio dos testes da M9-D692 e da M9-D703 (owner, tarefa, notificação e ack dos alertas): usuários e papéis de teste (rótulo QA-M9), leitura das
// tarefas e notificações criadas e limpeza do que foi gravado. Roda SÓ em banco descartável (127.0.0.1).
const crypto = require('node:crypto');
const base = require('./m9d691Env');

const { sup } = base;
const uuid = () => crypto.randomUUID();

async function setup() {
  const env = await base.setup();
  env.made = { users: [], roles: [], defs: [], triggers: [] };
  return env;
}

async function teardown(env) {
  for (const name of env.made.triggers) await env.admin.query(`DROP TRIGGER IF EXISTS ${name} ON core.tasks`);
  await env.admin.query("DELETE FROM core.tasks WHERE related_entity_type = 'analytics.alert_instance' AND company_id IN (:cs)", { replacements: { cs: [env.tenantA.companyId, env.tenantB.companyId] } });
  if (env.made.users.length) await env.admin.query('DELETE FROM core.notifications WHERE user_id IN (:ids)', { replacements: { ids: env.made.users } });
  if (env.made.defs.length) {
    await env.admin.query('DELETE FROM analytics.alert_instances WHERE alert_definition_id IN (:ids)', { replacements: { ids: env.made.defs } });
    await env.admin.query('DELETE FROM analytics.alert_definitions WHERE id IN (:ids)', { replacements: { ids: env.made.defs } });
  }
  if (env.made.users.length) {
    await env.admin.query('DELETE FROM core.user_memberships WHERE user_id IN (:ids)', { replacements: { ids: env.made.users } });
    await env.admin.query('DELETE FROM core.users WHERE id IN (:ids)', { replacements: { ids: env.made.users } });
  }
  if (env.made.roles.length) await env.admin.query('DELETE FROM core.roles WHERE id IN (:ids)', { replacements: { ids: env.made.roles } });
  await base.teardown(env);
}

/** Papel da empresa com nome único (QA-M9). */
async function makeRole(env, tenant, name = `QA-M9 papel ${uuid().slice(0, 8)}`) {
  const [[role]] = await env.admin.query(
    'INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :n, :n, now(), now()) RETURNING id, name',
    { replacements: { g: tenant.groupId, c: tenant.companyId, n: name } });
  env.made.roles.push(role.id);
  return role;
}

/** Usuário com vínculo na empresa (ACTIVE por padrão) e, opcionalmente, o papel. Ids em ordem crescente quando `id` é informado. */
async function makeUser(env, tenant, { role = null, status = 'ACTIVE', membership = status } = {}) {
  const id = uuid();
  await env.admin.query(
    "INSERT INTO core.users (id, name, email, password_hash, status) VALUES (:id, :n, :e, :p, :s)",
    { replacements: { id, n: `QA-M9 ${id.slice(0, 6)}`, e: `qa-m9-${id}@ci.nayaraone.test`, p: 'x'.repeat(60), s: status } });
  await env.admin.query(
    'INSERT INTO core.user_memberships (id, group_id, company_id, user_id, role_id, status) VALUES (gen_random_uuid(), :g, :c, :u, :r, :s)',
    { replacements: { g: tenant.groupId, c: tenant.companyId, u: id, r: role ? role.id : null, s: membership } });
  env.made.users.push(id);
  return id;
}

/** Define e publica um alerta; registra o id para a limpeza. */
async function define(env, tenant, metric, options = {}) {
  const def = await base.defineAlert(tenant, metric, options);
  env.made.defs.push(def.id);
  return def;
}

/** Define um alerta cujo owner é um usuário (e não um papel). */
async function defineForUser(env, tenant, metric, ownerUserId, options = {}) {
  const { sup: s, store, alertDefs } = base;
  const code = options.code || `al_${s.sfx()}`;
  const def = await s.inTx(tenant, { commit: true }, async (tx) => {
    await store.enableAnalyticsWriter(tx);
    const ctx = s.ctxOf(tenant);
    const row = await alertDefs.createAlertDefinition({
      scopeLevel: 'COMPANY', companyId: tenant.companyId, groupId: tenant.groupId, alertCode: code, metricCode: metric.code, conditionType: 'THRESHOLD',
      threshold: { operator: options.threshold ? options.threshold[0] : 'LT', value: options.threshold ? options.threshold[1] : 50000 }, severity: options.severity || 'WARNING',
      ownerUserId, createTask: options.createTask === true, autoResolvePolicy: options.autoResolve || {}, cooldownMinutes: options.cooldownMinutes ?? null,
    }, ctx, tx);
    return alertDefs.publishAlertDefinition(row.id, ctx, tx);
  });
  env.made.defs.push(def.id);
  return def;
}

const tasksOf = async (env, tenant) => (await env.admin.query(
  "SELECT * FROM core.tasks WHERE company_id = :c AND related_entity_type = 'analytics.alert_instance' AND deleted_at IS NULL ORDER BY created_at", { replacements: { c: tenant.companyId } }))[0];

const notificationsOf = async (env, tenant, instanceId) => (await env.admin.query(
  "SELECT * FROM core.notifications WHERE company_id = :c AND body LIKE :like ORDER BY created_at, user_id", { replacements: { c: tenant.companyId, like: `%${instanceId}%` } }))[0];

const auditOf = async (env, tenant, action) => (await env.admin.query(
  'SELECT * FROM audit.audit_log WHERE company_id = :c AND action = :a ORDER BY occurred_at', { replacements: { c: tenant.companyId, a: action } }))[0];

module.exports = { ...base, setup, teardown, makeRole, makeUser, define, defineForUser, tasksOf, notificationsOf, auditOf, uuid, sup };
