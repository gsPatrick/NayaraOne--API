'use strict';

require('dotenv').config();
const { sequelize, Company, Role, RolePermission, UserMembership } = require('../src/models');

/**
 * R9 (reconferência ao vivo 20/10/2026) — homologação. O seed-homo-m45.js vinculou o admin (e
 * os auditores) à empresa "HOMO QA — M45 Intercompany Destino" reaproveitando o roleId do ADMIN
 * da Empresa Dev. Papéis são POR EMPRESA (RLS), então nessa empresa o vínculo apontava para um
 * papel que ela não enxerga: ao trocar de empresa o token saía sem papéis nem permissões.
 * Este script (idempotente) cria o papel de sistema ADMIN DA EMPRESA DESTINO, com as mesmas
 * permissões do ADMIN da Empresa Dev, e reaponta os vínculos ATIVOS dessa empresa que usam o
 * papel de outra empresa. Nunca cria usuário. Recusa produção.
 * Uso: node scripts/seed-homo-admin-empresa-destino.js
 */
const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const SOURCE_COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const DEST_COMPANY_NAME = 'HOMO QA — M45 Intercompany Destino';

async function ctx(t, companyId, userId) {
  await sequelize.query(
    "SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
    { replacements: { g: GROUP_ID, c: companyId, u: userId || '' }, transaction: t }
  );
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') throw new Error('Seed de homologação proibido em produção.');
  const t = await sequelize.transaction();
  try {
    await ctx(t, SOURCE_COMPANY_ID);
    const sourceRole = await Role.findOne({ where: { companyId: SOURCE_COMPANY_ID, name: 'ADMIN', isSystem: true }, transaction: t });
    if (!sourceRole) throw new Error('Papel ADMIN da Empresa Dev não encontrado.');
    const sourcePerms = await RolePermission.findAll({ where: { roleId: sourceRole.id }, transaction: t });

    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: GROUP_ID }, transaction: t });
    const dest = await Company.findOne({ where: { groupId: GROUP_ID, name: DEST_COMPANY_NAME }, transaction: t });
    if (!dest) throw new Error('Empresa destino não encontrada (rode seed-homo-m45.js).');
    await ctx(t, dest.id);

    let role = await Role.findOne({ where: { companyId: dest.id, name: 'ADMIN', isSystem: true }, transaction: t });
    if (!role) {
      role = await Role.create(
        { groupId: GROUP_ID, companyId: dest.id, name: 'ADMIN', description: sourceRole.description, isSystem: true },
        { transaction: t }
      );
    }
    const have = new Set((await RolePermission.findAll({ where: { roleId: role.id }, transaction: t })).map((rp) => rp.permissionId));
    let added = 0;
    for (const rp of sourcePerms) {
      if (have.has(rp.permissionId)) continue;
      await RolePermission.create({ groupId: GROUP_ID, companyId: dest.id, roleId: role.id, permissionId: rp.permissionId }, { transaction: t });
      added += 1;
    }

    const rows = await UserMembership.findAll({ where: { companyId: dest.id, status: 'ACTIVE' }, transaction: t });
    let repointed = 0;
    for (const m of rows) {
      if (m.roleId === sourceRole.id) {
        await sequelize.query(
          'UPDATE core.user_memberships SET role_id = :r, updated_at = now() WHERE id = :id',
          { replacements: { r: role.id, id: m.id }, transaction: t }
        );
        repointed += 1;
      }
    }
    await t.commit();
    console.log(`Papel ADMIN da empresa destino ${role.id}: +${added} permissões; ${repointed} vínculo(s) reapontado(s).`);
  } catch (err) {
    await t.rollback();
    throw err;
  } finally {
    await sequelize.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
