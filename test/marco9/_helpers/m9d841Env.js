'use strict';

// Apoio dos testes M9-D841 (não é teste): consumidores, uso e deprecações gravados de verdade. Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const env = require('./bcpEnv');
const consumersApi = require('../../../src/features/core-governance/api-governance/consumers');

let seq = 0;
const unique = (label) => { seq += 1; return `QA-M9 ${label} ${Date.now()}-${seq}`; };
const DAY = 86400000;
const isoIn = (days) => new Date(Date.now() + days * DAY).toISOString();
const asOwner = (tenant, over = {}) => ({ ownerUserId: tenant.userId, ...over });

/** Consumidor externo como a M9-D844 o cria: pela função de cadastro, na transação da credencial. */
const registerConsumer = (tenant, over = {}) => env.inTx(tenant, (transaction) => consumersApi.registerConsumer({
  tenant: env.tenantOf(tenant), actorUserId: tenant.userId, name: unique('consumidor'), kind: 'PARTNER', ownerUserId: tenant.userId, transaction, ...over,
}));

/** Anuncia a deprecação pelo serviço (como a rota). */
const deprecate = (tenant, body) => env.inTx(tenant, (transaction) => consumersApi.createDeprecation({ tenant: env.tenantOf(tenant), actorUserId: tenant.userId, body, transaction }));

/** Uso por alvo gravado como o middleware grava; `ageDays` recua a última marca. */
const addUsage = (tenant, consumerId, targetKey, ageDays = 0) => env.adminQuery(
  `INSERT INTO governance.api_consumer_usage (group_id, company_id, consumer_id, target_key, last_seen_at) VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)
   ON CONFLICT (consumer_id, target_key) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`, [tenant.groupId, tenant.companyId, consumerId, targetKey, String(ageDays)]
);

const usageOf = async (consumerId) => (await env.adminQuery('SELECT target_key AS "targetKey", last_seen_at AS "lastSeenAt" FROM governance.api_consumer_usage WHERE consumer_id = $1 ORDER BY target_key', [consumerId])).rows;
const depRow = async (id) => (await env.adminQuery('SELECT * FROM governance.api_deprecations WHERE id = $1', [id])).rows[0] || null;
const dueEvents = async (consumerId) => (await env.adminQuery("SELECT * FROM integration.outbox_events WHERE event_type = 'api.consumer.deprecation_due' AND aggregate_id = $1", [consumerId])).rows;
const notesOf = async (tenant, like) => (await env.adminQuery('SELECT user_id AS "userId", title FROM core.notifications WHERE company_id = $1 AND title LIKE $2', [tenant.companyId, like])).rows;

/** Apaga o que os testes criaram (o consumidor semeado do front web, com app_key, fica). */
async function cleanApi() {
  await env.adminQuery("DELETE FROM core.notifications WHERE title LIKE '%/qa-m9/%'");
  await env.adminQuery("DELETE FROM integration.outbox_events WHERE event_type = 'api.consumer.deprecation_due' AND payload_json->>'target' LIKE '%/qa-m9/%'");
  await env.adminQuery('DELETE FROM governance.api_clients'); // credenciais (M9-D844) apontam para api_consumers; sobras de outros arquivos impediam apagar os consumidores
  await env.adminQuery('DELETE FROM governance.api_consumer_usage');
  await env.adminQuery('DELETE FROM governance.api_deprecations');
  await env.adminQuery('DELETE FROM governance.api_consumers WHERE app_key IS NULL');
  consumersApi.clearContextCache();
  consumersApi.resetUsageThrottle();
}

module.exports = { ...env, unique, isoIn, asOwner, registerConsumer, deprecate, addUsage, usageOf, depRow, dueEvents, notesOf, cleanApi, consumersApi, DAY };
