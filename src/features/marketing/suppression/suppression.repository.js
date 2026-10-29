'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/**
 * Supressão ativa (e não expirada) que vale para a tentativa: endereço (hash) ou pessoa, no canal, com finalidade nula (vale
 * para todas) ou igual. Devolve a primeira ou null.
 */
async function findActiveSuppression({ hashes, personId, channel, purpose, at }, tenant, transaction) {
  const [row] = await run(
    `SELECT id, reason, source, purpose, expires_at FROM marketing.suppression_list
      WHERE company_id = :companyId AND active = true AND channel = :channel AND (expires_at IS NULL OR expires_at > :at)
        AND (purpose IS NULL OR purpose = :purpose)
        AND (address_hash IN (:hashes) OR (person_id IS NOT NULL AND person_id = :personId))
      ORDER BY created_at ASC LIMIT 1`,
    { companyId: tenant.companyId, channel, purpose, at, personId: personId || null, hashes: hashes.length ? hashes : [''] }, transaction
  );
  return row || null;
}

/** Insere a supressão; duplicada (mesmo endereço, canal e finalidade ativa) devolve a existente com `created:false`. */
async function insertSuppression(data, tenant, transaction) {
  const [inserted] = await run(
    `INSERT INTO marketing.suppression_list (group_id, company_id, person_id, address_hash, channel, purpose, reason, source, expires_at, created_by, updated_by)
     VALUES (:groupId, :companyId, :personId, :addressHash, :channel, :purpose, :reason, :source, :expiresAt, :actor, :actor)
     ON CONFLICT (company_id, address_hash, channel, (COALESCE(purpose, '*'))) WHERE active DO NOTHING RETURNING *`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, personId: data.personId || null, addressHash: data.addressHash, channel: data.channel,
      purpose: data.purpose || null, reason: data.reason, source: data.source, expiresAt: data.expiresAt || null, actor: data.actor || null,
    }, transaction
  );
  if (inserted) return { row: inserted, created: true };
  const [existing] = await run(
    `SELECT * FROM marketing.suppression_list WHERE company_id = :companyId AND address_hash = :addressHash AND channel = :channel
        AND COALESCE(purpose, '*') = COALESCE(:purpose, '*') AND active = true`,
    { companyId: tenant.companyId, addressHash: data.addressHash, channel: data.channel, purpose: data.purpose || null }, transaction
  );
  return { row: existing, created: false };
}

const getForUpdate = async (id, tenant, transaction) => (await run(
  'SELECT * FROM marketing.suppression_list WHERE id = :id AND company_id = :companyId FOR UPDATE', { id, companyId: tenant.companyId }, transaction))[0] || null;

async function markLifted(id, actor, tenant, transaction) {
  const [row] = await run(
    `UPDATE marketing.suppression_list SET active = false, lifted_by = :actor, lifted_at = CURRENT_TIMESTAMP, updated_by = :actor, updated_at = CURRENT_TIMESTAMP
      WHERE id = :id AND company_id = :companyId RETURNING *`, { id, actor: actor || null, companyId: tenant.companyId }, transaction);
  return row;
}

/** Consentimento (people.communication_consents) por id, da empresa. */
const getConsent = async (id, tenant, transaction) => (await run(
  'SELECT id, person_id, channel, purpose, status, recorded_at FROM people.communication_consents WHERE id = :id AND company_id = :companyId',
  { id, companyId: tenant.companyId }, transaction))[0] || null;

module.exports = { findActiveSuppression, insertSuppression, getForUpdate, markLifted, getConsent };
