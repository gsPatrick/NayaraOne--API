'use strict';

// Apoio da M9-D627: grava as FONTES de Marketing e Atendimento por conexão de superusuário (sem FK, só o que o teste precisa) e guarda
// os ids para a limpeza no fim. Banco descartável apenas.
const crypto = require('node:crypto');

const uuid = () => crypto.randomUUID();
const MODELS = ['rm_mkt_campaigns', 'rm_mkt_delivery', 'rm_mkt_frequency', 'rm_mkt_reviews', 'rm_mkt_automation', 'rm_support_satisfaction', 'rm_support_complaints', 'rm_support_sla'];
const SOURCE_TABLES = ['crm.messages', 'crm.opportunities', 'crm.feedback_cases', 'marketing.campaigns', 'marketing.attribution_events', 'marketing.suppression_list', 'marketing.review_requests', 'marketing.automation_runs'];

async function insert(env, table, tenant, columns) {
  const id = uuid();
  const all = { id, group_id: tenant.groupId, company_id: tenant.companyId, ...columns };
  const names = Object.keys(all);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query(`INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((n) => (all[n] !== null && typeof all[n] === 'object' && !(all[n] instanceof Date) ? `CAST(:${n} AS jsonb)` : `:${n}`)).join(', ')})`,
      { replacements: Object.fromEntries(names.map((n) => [n, all[n] !== null && typeof all[n] === 'object' && !(all[n] instanceof Date) ? JSON.stringify(all[n]) : all[n]])), transaction });
  });
  env.created.push({ table, id });
  return id;
}

const message = (env, tenant, c) => insert(env, 'crm.messages', tenant, {
  person_id: c.person || uuid(), channel: c.channel || 'WHATSAPP', direction: c.direction || 'OUTBOUND', author_type: 'NAY', status: c.status || 'SENT',
  action_key: c.actionKey === undefined ? crypto.createHash('sha256').update(uuid()).digest('hex') : c.actionKey, purpose: c.purpose === undefined ? 'MARKETING' : c.purpose, created_at: c.at, updated_at: c.at,
});
const campaign = (env, tenant, c = {}) => insert(env, 'marketing.campaigns', tenant, {
  code: `QA-M9-${uuid().slice(0, 8)}`, name: 'QA-M9 campanha de outubro', objective: 'Vender o lançamento', owner_user_id: tenant.userId, status: c.status || 'RUNNING', cost_actual: c.cost || '0.00',
  objective_metric: 'SALES', target_value: 10, budget_amount: 12000, starts_at: new Date('2026-10-01T03:00:00Z'), ends_at: new Date('2026-10-31T03:00:00Z'), channels: '{WHATSAPP}', created_at: c.at || new Date(), updated_at: c.at || new Date(),
});
const opportunity = (env, tenant, c) => insert(env, 'crm.opportunities', tenant, { person_id: uuid(), campaign_id: c.campaignId || null, created_at: c.at, updated_at: c.at });
const attribution = (env, tenant, c) => insert(env, 'marketing.attribution_events', tenant, {
  event_type: c.type || 'LEAD_CREATED', person_id: uuid(), campaign_id: c.campaignId, opportunity_id: c.opportunityId || null, evidence_json: { origem: 'teste' }, valid: c.valid !== false, occurred_at: c.at,
});
const suppression = (env, tenant, c) => insert(env, 'marketing.suppression_list', tenant, {
  address_hash: crypto.createHash('sha256').update(uuid()).digest('hex'), channel: c.channel || 'WHATSAPP', reason: c.reason || 'OPT_OUT', source: 'QA-M9', active: true, created_at: c.at, updated_at: c.at,
});
const review = (env, tenant, c) => insert(env, 'marketing.review_requests', tenant, {
  person_id: uuid(), source_entity_type: 'Contract', source_entity_id: uuid(), channel: 'WHATSAPP', status: c.status || 'PENDING', platform: c.platform || null, public_rating: c.rating || null,
  satisfaction_score: c.score || null, completed_at: c.completedAt || null, created_at: c.at, updated_at: c.completedAt || c.at,
});
const run = (env, tenant, c) => insert(env, 'marketing.automation_runs', tenant, {
  automation_version_id: uuid(), correlation_id: uuid(), idempotency_key: `QA-M9:${uuid()}`, status: c.status || 'STARTED', started_at: c.startedAt, finished_at: c.finishedAt || null,
  created_at: c.startedAt, updated_at: c.finishedAt || c.startedAt,
});
const feedbackCase = (env, tenant, c) => insert(env, 'crm.feedback_cases', tenant, {
  person_id: uuid(), type: c.type || 'COMPLAINT', description: 'QA-M9 caso', severity: c.severity || 'MEDIUM', status: c.status || 'OPEN', sla_due_at: c.slaDueAt, resolved_at: c.resolvedAt || null,
  created_at: c.at, updated_at: c.resolvedAt || c.at,
});

/** Muda colunas de uma fonte já gravada (ex.: status de entrega que chega depois). */
async function update(env, table, id, set) {
  const names = Object.keys(set);
  await env.admin.query(`UPDATE ${table} SET ${names.map((n) => `"${n}" = :${n}`).join(', ')} WHERE id = :id`, { replacements: { ...set, id } });
}

async function cleanup(env) {
  const companies = [env.tenantA.companyId, env.tenantB.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const table of SOURCE_TABLES) {
      const ids = env.created.filter((c) => c.table === table).map((c) => c.id);
      if (ids.length) await env.admin.query(`DELETE FROM ${table} WHERE id IN (:ids)`, { replacements: { ids }, transaction });
    }
    for (const model of MODELS) await env.admin.query(`DELETE FROM analytics.${model} WHERE company_id IN (:c)`, { replacements: { c: companies }, transaction });
    await env.admin.query('DELETE FROM analytics.rm_applied_events WHERE read_model IN (:m)', { replacements: { m: MODELS }, transaction });
    await env.admin.query('DELETE FROM analytics.rm_stale_aggregates WHERE read_model IN (:m)', { replacements: { m: MODELS }, transaction });
    await env.admin.query('DELETE FROM analytics.read_model_refreshes WHERE read_model IN (:m)', { replacements: { m: MODELS }, transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE event_type IN ('analytics.read_model.rebuilt', 'crm.message.status_changed') AND company_id IN (:c)", { replacements: { c: companies }, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE key = 'analytics.marketing_atendimento.janela_reconferencia_dias' AND company_id IN (:c)", { replacements: { c: companies }, transaction });
  });
}

module.exports = { uuid, MODELS, insert, message, campaign, opportunity, attribution, suppression, review, run, feedbackCase, update, cleanup };
