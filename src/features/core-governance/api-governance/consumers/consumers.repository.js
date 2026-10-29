'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Acesso a governance.api_consumers e governance.api_consumer_usage (M9-D841). A RLS isola pela empresa; o filtro por company_id vale de qualquer forma. */
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

const COLUMNS = `c.id, c.group_id AS "groupId", c.company_id AS "companyId", c.name, c.kind, c.owner_user_id AS "ownerUserId", c.contact_email AS "contactEmail",
  c.api_version_used AS "apiVersionUsed", c.client_id AS "clientId", c.app_key AS "appKey", c.last_seen_at AS "lastSeenAt", c.status`;

async function insertConsumer(row, transaction) {
  const rows = await select(
    `INSERT INTO governance.api_consumers AS c (group_id, company_id, name, kind, owner_user_id, contact_email, api_version_used, client_id, app_key)
     VALUES (:groupId, :companyId, :name, :kind, :ownerUserId, :contactEmail, :apiVersionUsed, :clientId, :appKey)
     ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
    { contactEmail: null, apiVersionUsed: 1, clientId: null, appKey: null, ...row }, transaction
  );
  return rows[0] || null;
}

const findByAppKey = async (companyId, appKey, transaction) => (await select(
  `SELECT ${COLUMNS} FROM governance.api_consumers c WHERE c.company_id = :companyId AND c.app_key = :appKey`, { companyId, appKey }, transaction
))[0] || null;

/** A empresa de uma credencial externa só se sabe pelo client_id: a transação liga a chave de consulta (política api_consumer_client_lookup, só SELECT). */
async function findByClientId(clientId) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.api_client_lookup', 'on', true)", { transaction });
    return (await select(`SELECT ${COLUMNS} FROM governance.api_consumers c WHERE c.client_id = :clientId`, { clientId }, transaction))[0] || null;
  });
}

/** Usuário ativo da empresa (vínculo ACTIVE)? */
const isActiveMember = async (companyId, userId, transaction) => (await select(
  "SELECT 1 AS ok FROM core.user_memberships m WHERE m.company_id = :companyId AND m.user_id = :userId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL LIMIT 1", { companyId, userId }, transaction
)).length > 0;

/** O usuário ativo mais antigo da empresa: responsável do consumidor semeado do front web. */
const oldestActiveMember = async (companyId, transaction) => ((await select(
  "SELECT m.user_id AS id FROM core.user_memberships m WHERE m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL ORDER BY m.created_at, m.id LIMIT 1", { companyId }, transaction
))[0] || {}).id || null;

/**
 * Grava o uso (consumidor, alvo) no máximo uma vez por intervalo: o UPSERT só atualiza se a última marca for mais antiga (vale entre processos). Na marca MAJOR, atualiza também
 * `last_seen_at` e a major do consumidor. Devolve true se gravou.
 */
async function touchUsage({ consumer, targetKey, intervalMinutes }, transaction) {
  const rows = await select(
    `INSERT INTO governance.api_consumer_usage AS u (group_id, company_id, consumer_id, target_key, last_seen_at)
     VALUES (:groupId, :companyId, :consumerId, :targetKey, now())
     ON CONFLICT (consumer_id, target_key) DO UPDATE SET last_seen_at = now(), updated_at = now()
       WHERE u.last_seen_at <= now() - make_interval(mins => :minutes)
     RETURNING u.id`,
    { groupId: consumer.groupId, companyId: consumer.companyId, consumerId: consumer.id, targetKey, minutes: intervalMinutes }, transaction
  );
  if (!rows.length) return false;
  const major = /^MAJOR:(\d+)$/.exec(targetKey);
  if (major) {
    await select('UPDATE governance.api_consumers SET last_seen_at = now(), api_version_used = :major, updated_at = now() WHERE id = :id AND company_id = :companyId RETURNING id', { id: consumer.id, companyId: consumer.companyId, major: Number(major[1]) }, transaction);
  }
  return true;
}

module.exports = { COLUMNS, select, insertConsumer, findByAppKey, findByClientId, isActiveMember, oldestActiveMember, touchUsage };
