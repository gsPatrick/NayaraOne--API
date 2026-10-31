'use strict';

// Marco 9, M9-D200 (reabertura R3-M2) — permissão de plataforma nunca é atribuível por papel de empresa.
// Cobre CADA código de PLATFORM_PERMISSION_CODES por todos os caminhos da API de empresa: criar papel, editar papel e vincular usuário a papel que já a tenha.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { PLATFORM_PERMISSION_CODES } = require('../../../src/shared/platform-permissions');
const rolesService = require('../../../src/features/roles/roles.service');
const membershipService = require('../../../src/features/memberships/membership.service');
const { Permission, Role, RolePermission, User } = require('../../../src/models');

after(async () => { await sequelize.close(); });

const recusa = (err) => err && err.statusCode === 403 && err.code === 'PLATFORM_PERMISSION_NOT_ASSIGNABLE';

async function permissaoDe(codigo, t) {
  const p = await Permission.findOne({ where: { code: codigo }, transaction: t });
  assert.ok(p, `a permissão de plataforma ${codigo} precisa existir no catálogo`);
  return p;
}

test('plataforma_a_lista_de_permissoes_de_plataforma_inclui_integration_platform', () => {
  assert.ok(PLATFORM_PERMISSION_CODES.includes('integration:platform'));
});

test('plataforma_criar_papel_com_permissao_de_plataforma_e_recusado_por_cada_codigo', async () => {
  const tenant = await getSeedTenant();
  for (const codigo of PLATFORM_PERMISSION_CODES) {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const p = await permissaoDe(codigo, t);
      await assert.rejects(
        rolesService.createRole({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 ${uniqueSuffix()}`, permissionIds: [p.id] }, tenant.userId, t),
        recusa,
      );
    });
  }
});

test('plataforma_editar_papel_com_permissao_de_plataforma_e_recusado_por_cada_codigo', async () => {
  const tenant = await getSeedTenant();
  for (const codigo of PLATFORM_PERMISSION_CODES) {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const p = await permissaoDe(codigo, t);
      const papel = await rolesService.createRole({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 ${uniqueSuffix()}`, permissionIds: [] }, tenant.userId, t);
      await assert.rejects(rolesService.updateRole(papel.id, { permissionIds: [p.id] }, tenant.userId, t), recusa);
      const depois = await RolePermission.count({ where: { roleId: papel.id }, transaction: t });
      assert.equal(depois, 0, 'o papel não pode ter ficado com a permissão');
    });
  }
});

test('plataforma_vincular_usuario_a_papel_que_ja_tem_permissao_de_plataforma_e_recusado', async () => {
  const tenant = await getSeedTenant();
  for (const codigo of PLATFORM_PERMISSION_CODES) {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const p = await permissaoDe(codigo, t);
      // Papel preparado por operação da plataforma (direto no banco), nunca pela API da empresa.
      const papel = await Role.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 plataforma ${uniqueSuffix()}`, isSystem: false }, { transaction: t });
      await RolePermission.create({ roleId: papel.id, permissionId: p.id }, { transaction: t });
      const usuario = await User.findByPk(tenant.userId);
      assert.ok(usuario);
      await assert.rejects(
        membershipService.createMembership({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roleId: papel.id }, tenant.userId, t),
        recusa,
      );
    });
  }
});

test('plataforma_papel_comum_continua_funcionando', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await Permission.findOne({ where: { code: 'roles:read' }, transaction: t });
    assert.ok(p);
    const papel = await rolesService.createRole({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 ${uniqueSuffix()}`, permissionIds: [p.id] }, tenant.userId, t);
    assert.deepEqual(papel.permissions.map((x) => x.code), ['roles:read']);
  });
});
