'use strict';

require('dotenv').config();

const { sequelize, Group, Company, User } = require('../src/models');

/**
 * Helpers de teste (Marco 3) — rodam contra o banco real de dev (`nayara_one_dev`) via
 * `nayara_runtime` (mesmo usuário/RLS da aplicação em runtime; ver .env). Reutiliza o
 * tenant de seed criado por `scripts/seed-dev.js` (idempotente — roda `npm run seed` antes
 * dos testes se o tenant de seed ainda não existir).
 *
 * `withTenantTransaction` replica exatamente o que src/middlewares/tenant.middleware.js faz
 * em runtime: abre uma transação e roda `SET LOCAL app.group_id/app.company_id/app.user_id`
 * antes de qualquer query, garantindo que os testes exercitam o mesmo caminho de RLS que a
 * aplicação usa em produção — não um bypass de teste.
 */

const SEED_ADMIN_EMAIL = 'admin@nayaraone.dev';

async function getSeedTenant() {
  const group = await Group.findOne({ where: { name: 'Nayara One — Grupo Dev' } });
  if (!group) {
    throw new Error('Tenant de seed não encontrado. Rode "npm run seed" antes dos testes.');
  }
  const company = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    return Company.findOne({ where: { groupId: group.id, name: 'Nayara One — Empresa Dev' }, transaction });
  });
  if (!company) {
    throw new Error('Empresa de seed não encontrada. Rode "npm run seed" antes dos testes.');
  }
  // core.users não tem RLS (é global), então pode ser lido fora de contexto de tenant. Usamos
  // o usuário admin de seed como actor — várias tabelas (ex.: property_price_history.changed_by_user_id)
  // têm FK para core.users, então um UUID arbitrário não seria aceito pelo banco.
  const adminUser = await User.findOne({ where: { email: SEED_ADMIN_EMAIL } });
  if (!adminUser) {
    throw new Error('Usuário admin de seed não encontrado. Rode "npm run seed" antes dos testes.');
  }
  return { groupId: group.id, companyId: company.id, userId: adminUser.id };
}

async function withTenantTransaction(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return fn(transaction);
  });
}

/**
 * withRollbackTenantTransaction — mesma configuração de SET LOCAL de `withTenantTransaction`,
 * mas usa uma transação NÃO gerenciada pelo Sequelize (sem commit automático ao final do
 * callback), permitindo que o próprio teste decida fazer rollback explícito no `finally` —
 * usado para que dados de teste nunca fiquem persistidos no banco de dev compartilhado.
 */
async function withRollbackTenantTransaction(tenant, fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return await fn(transaction);
  } finally {
    await transaction.rollback();
  }
}

function uniqueSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

module.exports = {
  sequelize,
  getSeedTenant,
  withTenantTransaction,
  withRollbackTenantTransaction,
  uniqueSuffix,
};
