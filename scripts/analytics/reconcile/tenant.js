'use strict';

/**
 * M9-D708 — identidade dos comandos operacionais de reconciliação e aceite: empresa-alvo com o seu grupo, usuário (id ou e-mail) e as permissões efetivas
 * dele na empresa. Mesmo caminho do rebuildReadModel.js; cada leitura roda numa transação com as GUCs de grupo e empresa (RLS).
 */
const { sequelize, Group, Company, User } = require('../../../src/models');
const { getEffectiveAccess } = require('../../../src/features/memberships/effectivePermissions.service');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** { groupId, companyId } da empresa, ou null se não existir. */
async function findCompany(companyId) {
  for (const group of await Group.findAll()) {
    const found = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findOne({ where: { id: companyId }, transaction });
    });
    if (found) return { groupId: group.id, companyId: found.id };
  }
  return null;
}

const findUser = (ref) => User.findOne({ where: UUID.test(ref) ? { id: ref } : { email: ref.toLowerCase() } });

async function permissionsOf(userId, target) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: target.groupId, c: target.companyId }, transaction });
    return (await getEffectiveAccess(userId, target.companyId, transaction)).permissions;
  });
}

/** Executa `fn(transaction)` com as GUCs de grupo, empresa e usuário e confirma no fim. */
async function inTenant(target, userId, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
      { replacements: { g: target.groupId, c: target.companyId, u: userId || '' }, transaction });
    return fn(transaction);
  });
}

module.exports = { UUID, findCompany, findUser, permissionsOf, inTenant };
