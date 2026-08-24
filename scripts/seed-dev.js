'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { sequelize, Group, Company, User, UserMembership, Role, Permission, RolePermission } = require('../src/models');

/**
 * Seed de desenvolvimento — cria um group + company + role admin (com permissões amplas) +
 * usuário admin com senha conhecida, para permitir testar o fluxo ponta a ponta localmente
 * (login -> criar group -> criar company -> criar unit).
 *
 * Credenciais de teste: ver src/documentacao/ONBOARDING.md ("Seed de desenvolvimento").
 * NUNCA rodar contra um ambiente que não seja local/dev (Maturacao/01_ARQUITETURA...
 * "Nunca usar dados reais em ambiente de desenvolvimento" — este seed é o inverso: dados
 * fictícios apenas, nunca aponte DATABASE_URL/DB_* para produção ao rodar este script).
 */

const SEED_ADMIN_EMAIL = 'admin@nayaraone.dev';
const SEED_ADMIN_PASSWORD = 'DevAdmin#2026';

const ADMIN_PERMISSIONS = [
  'groups:create', 'groups:read', 'groups:update', 'groups:delete',
  'companies:create', 'companies:read', 'companies:update', 'companies:delete',
  'units:create', 'units:read', 'units:update', 'units:delete',
  'users:create', 'users:read', 'users:update', 'users:delete',
  'memberships:create', 'memberships:read', 'memberships:update', 'memberships:delete',
  'people:create', 'people:read', 'people:update', 'people:delete',
  'properties:create', 'properties:read', 'properties:update', 'properties:delete', 'properties:internal',
  'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:update', 'crm:opportunities:delete',
  'crm:visits:create', 'crm:visits:read', 'crm:visits:update', 'crm:visits:delete',
  'crm:messages:create', 'crm:messages:read', 'crm:messages:update', 'crm:messages:delete',
  'radar:create', 'radar:read', 'radar:update', 'radar:delete',
];

async function upsertPermissions() {
  const permissions = [];
  for (const code of ADMIN_PERMISSIONS) {
    const [permission] = await Permission.findOrCreate({
      where: { code },
      defaults: { code, description: `Permissão de seed: ${code}`, riskLevel: 'LOW' },
    });
    permissions.push(permission);
  }
  return permissions;
}

async function run() {
  await sequelize.authenticate();
  // eslint-disable-next-line no-console
  console.log('[seed-dev] Conectado ao banco. Iniciando seed...');

  // "core"."groups" não tem RLS (topo da hierarquia), então pode ser lido/criado fora de
  // contexto de tenant. Mas "core"."companies"/"core"."roles"/"core"."user_memberships" TÊM
  // RLS (policy tenant_isolation, fail closed) — o seed precisa abrir uma transação e fazer
  // SET LOCAL app.group_id/app.company_id ele mesmo, exatamente como req.withTenantTransaction
  // faz na aplicação (ver src/middlewares/tenant.middleware.js), senão toda leitura/escrita
  // nessas tabelas é negada pelo Postgres (ou, em SELECT, sempre retorna vazio, quebrando o
  // findOrCreate idempotente e duplicando registros a cada execução).
  const [group] = await Group.findOrCreate({
    where: { name: 'Nayara One — Grupo Dev' },
    defaults: { name: 'Nayara One — Grupo Dev', legalName: 'Nayara One Desenvolvimento Ltda (fictício)', status: 'ACTIVE' },
  });

  const permissions = await upsertPermissions();

  const existingUser = await User.findOne({ where: { email: SEED_ADMIN_EMAIL } });
  let adminUser = existingUser;
  if (!adminUser) {
    const passwordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 12);
    adminUser = await User.create({
      name: 'Admin Dev',
      email: SEED_ADMIN_EMAIL,
      passwordHash,
      status: 'ACTIVE',
    });
  }

  const { company, adminRole } = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });

    const [companyRow] = await Company.findOrCreate({
      where: { groupId: group.id, name: 'Nayara One — Empresa Dev' },
      defaults: { groupId: group.id, name: 'Nayara One — Empresa Dev', status: 'ACTIVE' },
      transaction,
    });

    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: companyRow.id },
      transaction,
    });

    const [roleRow] = await Role.findOrCreate({
      where: { groupId: group.id, companyId: companyRow.id, name: 'ADMIN' },
      defaults: {
        groupId: group.id,
        companyId: companyRow.id,
        name: 'ADMIN',
        description: 'Papel administrativo de seed (todas as permissões do escopo Marco 1/2).',
        isSystem: true,
      },
      transaction,
    });

    for (const permission of permissions) {
      await RolePermission.findOrCreate({ where: { roleId: roleRow.id, permissionId: permission.id }, transaction });
    }

    await UserMembership.findOrCreate({
      where: { userId: adminUser.id, groupId: group.id, companyId: companyRow.id },
      defaults: { userId: adminUser.id, groupId: group.id, companyId: companyRow.id, roleId: roleRow.id, status: 'ACTIVE' },
      transaction,
    });

    return { company: companyRow, adminRole: roleRow };
  });

  // eslint-disable-next-line no-console
  console.log('[seed-dev] Seed concluído com sucesso:');
  // eslint-disable-next-line no-console
  console.log({
    groupId: group.id,
    companyId: company.id,
    adminRoleId: adminRole.id,
    adminUserId: adminUser.id,
    adminEmail: SEED_ADMIN_EMAIL,
    adminPassword: SEED_ADMIN_PASSWORD,
  });

  await sequelize.close();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed-dev] Falha ao rodar o seed:', err);
  process.exitCode = 1;
});
