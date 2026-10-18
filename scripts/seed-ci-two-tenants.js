'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission } = require('../src/models');

/**
 * Seed do ambiente isolado de CI — dois tenants fictícios, cada um com três perfis:
 *   MAKER   — cria/solicita (procurement:create, procurement:read)
 *   CHECKER — aprova (procurement:approve, procurement:read) e também pode solicitar
 *             (procurement:create): assim o teste prova que a segregação "quem cria não aprova"
 *             vem da REGRA de negócio, não da simples ausência de permissão.
 *   LEITURA — só lê (procurement:read)
 *
 * Pedido da conferência da Nayara (18/10/2026, roteiro item 4): "ambiente isolado e descartável
 * com fixtures fictícias, dois tenants e perfis maker/checker/leitura". Roda SÓ no workflow do
 * CI, depois do seed-dev, contra o Postgres descartável do job. Idempotente (findOrCreate).
 *
 * A senha dos usuários fictícios vem de CI_TENANT_USERS_PASSWORD (definida no workflow, exclusiva
 * do CI) — nunca fica gravada neste arquivo. Permissões são buscadas no catálogo real
 * (core.permissions) já populado pelo seed-dev; se faltar alguma, o seed falha em vez de inventar.
 */

const TENANTS = [
  { key: 'A', groupName: 'CI — Grupo Fictício A', companyName: 'CI — Empresa Fictícia A' },
  { key: 'B', groupName: 'CI — Grupo Fictício B', companyName: 'CI — Empresa Fictícia B' },
];

const PROFILES = [
  { key: 'maker', roleName: 'CI MAKER', permissions: ['procurement:create', 'procurement:read'] },
  { key: 'checker', roleName: 'CI CHECKER', permissions: ['procurement:approve', 'procurement:read', 'procurement:create'] },
  { key: 'leitura', roleName: 'CI LEITURA', permissions: ['procurement:read'] },
];

function emailFor(tenantKey, profileKey) {
  return `ci-${tenantKey.toLowerCase()}-${profileKey}@ci.nayaraone.test`;
}

async function run() {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error('Defina CI_TENANT_USERS_PASSWORD (mínimo 10 caracteres) para rodar este seed.');
  }
  await sequelize.authenticate();
  const passwordHash = await bcrypt.hash(password, 10);

  const permissionByCode = {};
  for (const code of new Set(PROFILES.flatMap((p) => p.permissions))) {
    const permission = await Permission.findOne({ where: { code } });
    if (!permission) throw new Error(`Permissão "${code}" ausente do catálogo — rode o seed-dev antes.`);
    permissionByCode[code] = permission;
  }

  const summary = [];
  for (const tenantDef of TENANTS) {
    const [group] = await Group.findOrCreate({
      where: { name: tenantDef.groupName },
      defaults: { name: tenantDef.groupName, legalName: `${tenantDef.groupName} (fictício, CI)`, status: 'ACTIVE' },
    });

    await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: group.id }, transaction });
      const [company] = await Company.findOrCreate({
        where: { groupId: group.id, name: tenantDef.companyName },
        defaults: { groupId: group.id, name: tenantDef.companyName, status: 'ACTIVE' },
        transaction,
      });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: company.id }, transaction });

      for (const profile of PROFILES) {
        const [role] = await Role.findOrCreate({
          where: { groupId: group.id, companyId: company.id, name: profile.roleName },
          defaults: {
            groupId: group.id,
            companyId: company.id,
            name: profile.roleName,
            description: `Perfil fictício de CI (${profile.key}) — tenant ${tenantDef.key}.`,
            isSystem: false,
          },
          transaction,
        });
        for (const code of profile.permissions) {
          await RolePermission.findOrCreate({
            where: { roleId: role.id, permissionId: permissionByCode[code].id },
            transaction,
          });
        }

        const email = emailFor(tenantDef.key, profile.key);
        const [user] = await User.findOrCreate({
          where: { email },
          defaults: { name: `CI ${profile.key} — tenant ${tenantDef.key}`, email, passwordHash, status: 'ACTIVE' },
          transaction,
        });
        await UserMembership.findOrCreate({
          where: { userId: user.id, groupId: group.id, companyId: company.id },
          defaults: { userId: user.id, groupId: group.id, companyId: company.id, roleId: role.id, status: 'ACTIVE' },
          transaction,
        });
        summary.push({ tenant: tenantDef.key, profile: profile.key, email, permissions: profile.permissions.join(',') });
      }
    });
  }

  // eslint-disable-next-line no-console
  console.log('[seed-ci-two-tenants] Concluído (senha via CI_TENANT_USERS_PASSWORD, não exibida):');
  // eslint-disable-next-line no-console
  console.table(summary);
  await sequelize.close();
}

if (require.main === module) {
  run().catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[seed-ci-two-tenants] Falha:', err.message);
    await sequelize.close().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { TENANTS, PROFILES, emailFor };
