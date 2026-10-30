'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Group, Company } = require('../../../../models');

/**
 * M9-D442 — ambiente do ensaio. Cada cenário roda numa transação de empresa (RLS real: group_id, company_id, user_id) que NUNCA é confirmada: tudo o que o ensaio cria
 * (conteúdo, jobs, resultados, conexão do sandbox, estado do circuito) some no rollback, de modo que o ensaio é repetível e não deixa resíduo.
 */

/** Empresa do ensaio (a informada ou a primeira) e duas pessoas distintas: quem gera o conteúdo e quem aprova. Devolve { tenant, reviewer } ou null. */
async function pickTenant(companyId = null) {
  const groups = await Group.findAll({ order: [['created_at', 'ASC']] });
  for (const group of groups) {
    const company = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: group.id }, transaction });
      return Company.findOne({ where: companyId ? { id: companyId } : {}, order: [['created_at', 'ASC']], transaction });
    });
    if (!company) continue;
    const users = await sequelize.query('SELECT id FROM core.users WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 2', { type: QueryTypes.SELECT });
    if (users.length < 2) return null;
    return { tenant: { groupId: group.id, companyId: company.id, userId: users[0].id }, reviewer: users[1].id };
  }
  return null;
}

/** Roda `fn(transaction)` na transação da empresa e SEMPRE a desfaz. */
async function withDrillTransaction(tenant, fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    return await fn(transaction);
  } finally {
    await transaction.rollback().catch(() => {});
  }
}

const query = (transaction, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

module.exports = { pickTenant, withDrillTransaction, query };
