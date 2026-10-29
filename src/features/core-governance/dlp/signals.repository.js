'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso a governance.access_signals (M9-D824). A RLS isola pela empresa da sessão; o filtro explícito por company_id vale de qualquer forma. */
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

async function insert(tenant, row, transaction) {
  await sequelize.query(
    `INSERT INTO governance.access_signals (group_id, company_id, user_id, kind, action, classification, outcome, resource_type, count, occurred_at)
     VALUES (:groupId, :companyId, :userId, :kind, :action, :classification, :outcome, :resourceType, :count, :occurredAt)`,
    { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, resourceType: null, ...row } }
  );
}

/** Serializa o registro e a contagem de um usuário (sem isso duas transações simultâneas não enxergam os sinais uma da outra). */
async function lockUser(tenant, userId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 824))', { transaction, replacements: { key: `${tenant.companyId}:${userId}` } });
}

/** Soma dos itens da janela (agregada no banco, dentro da transação da decisão). `kinds` = tipos de sinal somados; `classification` filtra a classe quando informada. */
async function sumInWindow(tenant, userId, { kinds, classification = null, since, until }, transaction) {
  const rows = await select(
    `SELECT COALESCE(sum(count), 0)::int AS total, COALESCE(sum(count) FILTER (WHERE outcome = 'DENIED'), 0)::int AS denied, count(*)::int AS signals
       FROM governance.access_signals
      WHERE company_id = :companyId AND user_id = :userId AND kind IN (:kinds) AND occurred_at > :since AND occurred_at <= :until
        AND (CAST(:classification AS varchar) IS NULL OR classification = :classification)`,
    { companyId: tenant.companyId, userId, kinds, classification, since, until },
    transaction
  );
  return rows[0];
}

module.exports = { insert, lockUser, sumInWindow };
