'use strict';

// Apoio dos testes M9-D804 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const base = require('./m9d803Env');
const { User, UserMembership, Role } = require('../../../src/models');

const { sequelize } = base;
const actorOf = (tenant) => ({ userId: tenant.userId, roles: ['ADMIN'] });

/** Usuário novo com vínculo ATIVO na empresa (papel do gestor do seed), dentro da transação do teste. */
async function newUser(tenant, tx, { status = 'ACTIVE', membership = 'ACTIVE', roleName = null } = {}) {
  const [owner] = await sequelize.query('SELECT role_id FROM core.user_memberships WHERE user_id = :u AND company_id = :c LIMIT 1', {
    type: QueryTypes.SELECT, transaction: tx, replacements: { u: tenant.userId, c: tenant.companyId },
  });
  let roleId = owner.role_id;
  if (roleName) {
    const found = await Role.findOne({ where: { companyId: tenant.companyId, name: roleName }, transaction: tx });
    roleId = (found || await Role.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: roleName, description: 'QA-M9' }, { transaction: tx })).id;
  }
  const suffix = randomUUID().slice(0, 8);
  const user = await User.create({ name: `QA-M9 ${suffix}`, email: `qa-m9-${suffix}@ci.nayaraone.test`, passwordHash: 'x'.repeat(60), status }, { transaction: tx });
  await UserMembership.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId: user.id, roleId, status: membership }, { transaction: tx });
  return user;
}

/** Todas as linhas (vigentes e fechadas) de um domínio, em ordem de criação. */
async function history(tenant, code, tx) {
  return sequelize.query(
    `SELECT a.role, a.user_id, a.valid_until, a.close_reason FROM governance.data_domain_assignments a JOIN governance.data_domains d ON d.id = a.domain_id
      WHERE a.company_id = :c AND d.code = :code ORDER BY a.valid_until NULLS LAST, a.id`,
    { type: QueryTypes.SELECT, transaction: tx, replacements: { c: tenant.companyId, code } }
  );
}

module.exports = { ...base, randomUUID, actorOf, newUser, history, sequelize };
