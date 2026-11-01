'use strict';

// Marco 9, M9-D200 (reabertura R4-L4) — o papel e o vínculo do operador de plataforma não são alterados pela API de empresa.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { PLATFORM_PERMISSION_CODES } = require('../../../src/shared/platform-permissions');
const rolesService = require('../../../src/features/roles/roles.service');
const membershipService = require('../../../src/features/memberships/membership.service');
const { Permission, Role, RolePermission, UserMembership } = require('../../../src/models');

after(async () => { await sequelize.close(); });

const protegido = (err) => err && err.statusCode === 403 && err.code === 'PLATFORM_ROLE_PROTECTED';

/** Papel do operador, preparado pela operação da plataforma (direto no banco, sem autor) para CADA código de plataforma. */
async function papelDoOperador(tenant, codigo, t) {
  const p = await Permission.findOne({ where: { code: codigo }, transaction: t });
  assert.ok(p, `a permissão ${codigo} precisa existir`);
  const papel = await Role.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 operador ${uniqueSuffix()}`, isSystem: false }, { transaction: t });
  await RolePermission.create({ roleId: papel.id, permissionId: p.id }, { transaction: t });
  return papel;
}

test('plataforma_papel_do_operador_nao_e_editado_renomeado_esvaziado_nem_apagado_pela_empresa', async () => {
  const tenant = await getSeedTenant();
  for (const codigo of PLATFORM_PERMISSION_CODES) {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const papel = await papelDoOperador(tenant, codigo, t);
      await assert.rejects(rolesService.updateRole(papel.id, { name: 'renomeado' }, tenant.userId, t), protegido);
      await assert.rejects(rolesService.updateRole(papel.id, { permissionIds: [] }, tenant.userId, t), protegido);
      await assert.rejects(rolesService.removeRole(papel.id, tenant.userId, t), protegido);
      const depois = await Role.findByPk(papel.id, { transaction: t });
      assert.ok(depois, 'o papel segue existindo');
      assert.match(depois.name, /^QA-M9 operador/);
      assert.equal(await RolePermission.count({ where: { roleId: papel.id }, transaction: t }), 1, 'a permissão segue no papel');
    });
  }
});

test('plataforma_vinculo_do_operador_nao_e_revogado_pela_empresa', async () => {
  const tenant = await getSeedTenant();
  for (const codigo of PLATFORM_PERMISSION_CODES) {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const papel = await papelDoOperador(tenant, codigo, t);
      const vinculo = await UserMembership.create({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roleId: papel.id, status: 'ACTIVE' }, { transaction: t });
      await assert.rejects(membershipService.revokeMembership(vinculo.id, tenant.userId, t), protegido);
      const depois = await UserMembership.findByPk(vinculo.id, { transaction: t });
      assert.equal(depois.status, 'ACTIVE', 'o vínculo segue ativo');
    });
  }
});

test('plataforma_papel_comum_continua_editavel_e_removivel_e_vinculo_comum_revogavel', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const comum = await rolesService.createRole({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 ${uniqueSuffix()}`, permissionIds: [] }, tenant.userId, t);
    const editado = await rolesService.updateRole(comum.id, { name: `QA-M9 novo ${uniqueSuffix()}` }, tenant.userId, t);
    assert.match(editado.name, /^QA-M9 novo/);
    const vinculo = await UserMembership.create({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roleId: comum.id, status: 'ACTIVE' }, { transaction: t });
    const revogado = await membershipService.revokeMembership(vinculo.id, tenant.userId, t);
    assert.equal(revogado.status, 'REVOKED');
    await rolesService.removeRole(comum.id, tenant.userId, t);
    assert.equal(await Role.count({ where: { id: comum.id }, transaction: t }), 0);
  });
});
