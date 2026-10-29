'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Acesso a governance.idempotency_keys (M9-D843). UNIQUE (company_id, scope, key); a RLS isola pela empresa. */
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, request_hash AS "requestHash", response_status AS "responseStatus", response_body AS "responseBody"';

/** Apaga a chave vencida de (empresa, escopo, chave): depois do prazo a chave volta a valer como nova. */
const deleteExpired = (companyId, scope, key, transaction) => select(
  'DELETE FROM governance.idempotency_keys WHERE company_id = :companyId AND scope = :scope AND key = :key AND expires_at <= now() RETURNING id', { companyId, scope, key }, transaction
);

/** Reivindica a chave NA transação do efeito. Devolve a linha criada, ou null se a chave já existia (o INSERT espera a transação dona da chave terminar). */
async function claim({ groupId, companyId, scope, key, requestHash, validityHours }, transaction) {
  const rows = await select(
    `INSERT INTO governance.idempotency_keys (group_id, company_id, scope, key, request_hash, expires_at)
     VALUES (:groupId, :companyId, :scope, :key, :requestHash, now() + make_interval(hours => :validityHours))
     ON CONFLICT (company_id, scope, key) DO NOTHING RETURNING id`,
    { groupId, companyId, scope, key, requestHash, validityHours }, transaction
  );
  return rows[0] || null;
}

const find = async (companyId, scope, key, transaction) => (await select(`SELECT ${COLUMNS} FROM governance.idempotency_keys WHERE company_id = :companyId AND scope = :scope AND key = :key`, { companyId, scope, key }, transaction))[0] || null;

/** Grava a resposta original (status e corpo) da chave que esta requisição venceu. */
async function storeResponse({ companyId, scope, key, status, body }) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.company_id', :companyId, true)", { replacements: { companyId }, transaction });
    await sequelize.query(
      'UPDATE governance.idempotency_keys SET response_status = :status, response_body = CAST(:body AS jsonb), updated_at = now() WHERE company_id = :companyId AND scope = :scope AND key = :key',
      { replacements: { companyId, scope, key, status, body: JSON.stringify(body === undefined ? null : body) }, transaction }
    );
  });
}

/** Apaga as chaves vencidas de todas as empresas (job de limpeza). Cada empresa na sua transação; devolve o total apagado. */
async function cleanupExpired(companyIds) {
  let total = 0;
  for (const companyId of companyIds) {
    total += await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.company_id', :companyId, true)", { replacements: { companyId }, transaction });
      const [, meta] = await sequelize.query('DELETE FROM governance.idempotency_keys WHERE company_id = :companyId AND expires_at <= now()', { replacements: { companyId }, transaction });
      return meta && meta.rowCount ? meta.rowCount : 0;
    });
  }
  return total;
}

module.exports = { deleteExpired, claim, find, storeResponse, cleanupExpired };
