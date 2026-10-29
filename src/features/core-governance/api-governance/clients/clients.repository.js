'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Acesso a governance.api_clients e governance.api_scopes (M9-D844). A RLS isola pela empresa; o filtro por company_id vale de qualquer forma. */
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

const COLUMNS = `c.id, c.group_id AS "groupId", c.company_id AS "companyId", c.consumer_id AS "consumerId", c.name, c.client_id AS "clientId", c.scopes, c.status,
  c.created_by AS "createdBy", c.revoked_by AS "revokedBy", c.revoked_at AS "revokedAt", c.created_at AS "createdAt"`;

const scopeCatalog = (transaction) => select('SELECT code, description_pt AS description FROM governance.api_scopes ORDER BY code', {}, transaction);

async function insertClient(row, transaction) {
  return (await select(
    `INSERT INTO governance.api_clients AS c (group_id, company_id, consumer_id, name, client_id, secret_hash, scopes, created_by)
     VALUES (:groupId, :companyId, :consumerId, :name, :clientId, :secretHash, ARRAY[:scopes]::text[], :createdBy) RETURNING ${COLUMNS}`,
    row, transaction
  ))[0];
}

/** A empresa de uma credencial só se sabe pelo client_id: a transação liga a chave de consulta (política api_client_lookup, só SELECT). Devolve também o hash do segredo. */
async function findByClientId(clientId) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.api_client_lookup', 'on', true)", { transaction });
    return (await select(`SELECT ${COLUMNS}, c.secret_hash AS "secretHash" FROM governance.api_clients c WHERE c.client_id = :clientId`, { clientId }, transaction))[0] || null;
  });
}

/** Situação atual de uma credencial na própria empresa (a conferência de cada chamada externa: consulta indexada, sem cache). */
const statusOf = async (companyId, clientId, transaction) => (await select(
  'SELECT c.status FROM governance.api_clients c WHERE c.company_id = :companyId AND c.client_id = :clientId', { companyId, clientId }, transaction
))[0] || null;

const findById = async (companyId, id, transaction, lock = false) => (await select(
  `SELECT ${COLUMNS} FROM governance.api_clients c WHERE c.company_id = :companyId AND c.id = :id ${lock ? 'FOR UPDATE' : ''}`, { companyId, id }, transaction
))[0] || null;

async function listClients({ companyId, status, limit, offset }, transaction) {
  const where = `c.company_id = :companyId ${status ? 'AND c.status = :status' : ''}`;
  const items = await select(`SELECT ${COLUMNS} FROM governance.api_clients c WHERE ${where} ORDER BY c.created_at DESC, c.id LIMIT :limit OFFSET :offset`, { companyId, status, limit, offset }, transaction);
  const [{ total }] = await select(`SELECT count(*)::int AS total FROM governance.api_clients c WHERE ${where}`, { companyId, status }, transaction);
  return { items, total };
}

const markRevoked = async (companyId, id, userId, transaction) => (await select(
  `UPDATE governance.api_clients c SET status = 'REVOKED', revoked_at = now(), revoked_by = :userId, updated_at = now() WHERE c.company_id = :companyId AND c.id = :id RETURNING ${COLUMNS}`,
  { companyId, id, userId }, transaction
))[0];

module.exports = { select, scopeCatalog, insertClient, findByClientId, statusOf, findById, listClients, markRevoked };
