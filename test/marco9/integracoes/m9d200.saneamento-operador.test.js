'use strict';

// Marco 9, M9-D200 (reabertura R5-L2) — a migration de saneamento NUNCA tira permissão do papel do operador (nem editado por ADMIN antes da trava, registrando antes e depois),
// e a migration complementar relata (sem alterar) o valor de chave protegida gravado por quem não tem a permissão do dono e devolve a permissão perdida na limpeza antiga.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { PLATFORM_PERMISSION_CODES } = require('../../../src/shared/platform-permissions');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const saneamento = require('../../../migrations/20260101009962-sanear-permissao-e-parametros-de-plataforma');
const relatorio = require('../../../migrations/20260101009963-relatorio-saneamento-chaves-protegidas');
const { Permission, Role, RolePermission, UserMembership } = require('../../../src/models');

after(async () => { await sequelize.close(); });

const q = (t) => (sql, replacements) => sequelize.query(sql, { replacements, transaction: t });
const linhas = async (t, sql, replacements) => (await q(t)(sql, replacements))[0];
const auditorias = async (t, action, entityId) => linhas(t, 'SELECT * FROM audit.audit_log WHERE action = :a AND entity_id = :e', { a: action, e: entityId });

async function papelOperador(tenant, t, { rpAutor, roleAutor }) {
  const p = await Permission.findOne({ where: { code: PLATFORM_PERMISSION_CODES[0] }, transaction: t });
  const r = await Role.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 ${uniqueSuffix()}`, isSystem: false, createdBy: roleAutor ? tenant.userId : null }, { transaction: t });
  await RolePermission.create({ roleId: r.id, permissionId: p.id, createdBy: rpAutor ? tenant.userId : null }, { transaction: t });
  return { role: r, permission: p };
}

const inserir = (t, tenant, key, updatedBy, value = '"x"') => q(t)(
  `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, updated_by, created_at, updated_at)
   VALUES (gen_random_uuid(), :g, :c, :key, :v::jsonb, :u, now(), now()) ON CONFLICT (company_id, key) DO UPDATE SET updated_by = EXCLUDED.updated_by, value = EXCLUDED.value, deleted_at = NULL`,
  { g: tenant.groupId, c: tenant.companyId, key, v: value, u: updatedBy });

test('saneamento_nunca_remove_permissao_do_papel_do_operador_editado_pelo_admin_e_registra_antes_e_depois', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { role } = await papelOperador(tenant, t, { rpAutor: true, roleAutor: false }); // papel da operação, permissão recriada com autor por edição do ADMIN
    const indevido = await papelOperador(tenant, t, { rpAutor: true, roleAutor: true }); // papel de empresa
    await UserMembership.create({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
    await inserir(t, tenant, 'integration.egress.provider_hosts', tenant.userId);
    const r = await saneamento.sanear(q(t));
    assert.equal(await RolePermission.count({ where: { roleId: role.id }, transaction: t }), 1, 'o papel do operador não perde a permissão');
    assert.equal(await RolePermission.count({ where: { roleId: indevido.role.id }, transaction: t }), 0, 'o de empresa perde');
    const [reg] = await auditorias(t, 'roles.platform_permission_preserved', role.id);
    assert.ok(reg, 'a preservação deixa registro');
    assert.equal(reg.before_json.permission, PLATFORM_PERMISSION_CODES[0]);
    assert.equal(reg.after_json.preserved, true);
    assert.ok(r.preservadas >= 1);
    assert.equal((await linhas(t, 'SELECT 1 FROM core.tenant_settings WHERE company_id = :c AND key = :k', { c: tenant.companyId, k: 'integration.egress.provider_hosts' })).length, 1, 'valor do operador editado também fica');
    assert.equal((await saneamento.sanear(q(t))).preservadas, 0, 'idempotente: um registro por papel');
  });
});

test('relatorio_lista_chave_protegida_gravada_sem_a_permissao_do_dono_e_nao_altera_o_valor', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const chave = 'marketing.autopublish.classes';
    assert.equal(restrictedPermissionOf(chave), 'marketing:automation:manage');
    await q(t)('DELETE FROM core.tenant_settings WHERE company_id = :c AND key = :k', { c: tenant.companyId, k: chave });
    await inserir(t, tenant, chave, tenant.userId, '"[]"');
    // o autor sem a permissão do dono: sai no relatório
    await q(t)(`DELETE FROM core.role_permissions rp USING core.permissions p WHERE p.id = rp.permission_id AND p.code = 'marketing:automation:manage' AND rp.role_id IN (SELECT role_id FROM core.user_memberships WHERE user_id = :u)`, { u: tenant.userId });
    const [{ id }] = await linhas(t, 'SELECT id FROM core.tenant_settings WHERE company_id = :c AND key = :k', { c: tenant.companyId, k: chave });
    const r = await relatorio.relatar(q(t), restrictedPermissionOf);
    assert.ok(r.relatadas >= 1);
    const [reg] = await auditorias(t, 'settings.protected_key_review', id);
    assert.equal(reg.before_json.key, chave);
    assert.equal(reg.before_json.requiredPermission, 'marketing:automation:manage');
    assert.equal(reg.after_json.kept, true);
    assert.equal((await linhas(t, 'SELECT value FROM core.tenant_settings WHERE id = :id', { id }))[0].value, '[]', 'o valor não é alterado');
    assert.equal((await relatorio.relatar(q(t), restrictedPermissionOf)).relatadas, 0, 'idempotente');
    // chave comum nunca entra
    await inserir(t, tenant, 'mfa.nao_existe_comum', tenant.userId);
    assert.equal((await relatorio.relatar(q(t), restrictedPermissionOf)).relatadas, 0);
  });
});

test('relatorio_restaura_permissao_do_papel_da_operacao_perdida_na_limpeza_antiga_e_nunca_a_de_empresa', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const operador = await papelOperador(tenant, t, { rpAutor: false, roleAutor: false });
    const empresa = await papelOperador(tenant, t, { rpAutor: false, roleAutor: true });
    for (const { role, permission } of [operador, empresa]) {
      await q(t)('DELETE FROM core.role_permissions WHERE role_id = :r AND permission_id = :p', { r: role.id, p: permission.id });
      await q(t)(`INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
        VALUES (gen_random_uuid(), :g, :c, NULL, 'roles.platform_permission_sanitized', 'Role', :id, :b::jsonb, '{}'::jsonb, 'x', now(), now(), now())`,
      { g: tenant.groupId, c: tenant.companyId, id: role.id, b: JSON.stringify({ permission: permission.code }) });
    }
    const r = await relatorio.restaurar(q(t));
    assert.ok(r.restauradas >= 1);
    const dele = await RolePermission.findAll({ where: { roleId: operador.role.id }, transaction: t });
    assert.equal(dele.length, 1, 'a permissão volta ao papel da operação');
    assert.equal(dele[0].createdBy, null);
    assert.equal(await RolePermission.count({ where: { roleId: empresa.role.id }, transaction: t }), 0, 'papel criado por empresa nunca é restaurado');
    const [reg] = await auditorias(t, 'roles.platform_permission_restored', operador.role.id);
    assert.equal(reg.before_json.permission, null);
    assert.equal(reg.after_json.permission, PLATFORM_PERMISSION_CODES[0]);
    assert.equal((await relatorio.restaurar(q(t))).restauradas, 0, 'idempotente');
  });
});

test('relatorio_cobre_toda_chave_protegida_do_esquema', () => {
  const protegidas = Object.keys(SETTINGS_SCHEMA).filter((k) => !SETTINGS_SCHEMA[k].platformOnly && restrictedPermissionOf(k));
  assert.ok(protegidas.length > 30, 'o esquema tem famílias protegidas (Marketing, NAY, SLO, migração, governança, MFA)');
  for (const prefixo of ['marketing.', 'governanca.', 'migracao.', 'mfa.']) assert.ok(protegidas.some((k) => k.startsWith(prefixo)), `família ${prefixo}`);
});
