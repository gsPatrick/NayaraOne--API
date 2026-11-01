'use strict';

// Marco 9, M9-D200 (reabertura R4-L2) — a migration de saneamento remove o que foi atribuído/gravado pela empresa antes das travas, preserva o legítimo e é idempotente.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { PLATFORM_PERMISSION_CODES } = require('../../../src/shared/platform-permissions');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const migracao = require('../../../migrations/20260101009962-sanear-permissao-e-parametros-de-plataforma');
const { Permission, Role, RolePermission, UserMembership } = require('../../../src/models');

after(async () => { await sequelize.close(); });

const CHAVE = 'integration.egress.provider_hosts';
const roda = (t) => migracao.sanear((sql, replacements) => sequelize.query(sql, { replacements, transaction: t }));
const linhas = async (sql, replacements, t) => (await sequelize.query(sql, { replacements, transaction: t }))[0];

async function papel(tenant, t, { autor }) {
  const p = await Permission.findOne({ where: { code: PLATFORM_PERMISSION_CODES[0] }, transaction: t });
  const r = await Role.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 ${uniqueSuffix()}`, isSystem: false, createdBy: autor ? tenant.userId : null }, { transaction: t });
  await RolePermission.create({ roleId: r.id, permissionId: p.id, createdBy: autor ? tenant.userId : null }, { transaction: t });
  return r;
}

test('saneamento_listas_da_migration_acompanham_o_codigo', () => {
  const doEsquema = Object.entries(SETTINGS_SCHEMA).filter(([, v]) => v.platformOnly).map(([k]) => k).sort();
  assert.deepEqual([...migracao.PLATFORM_ONLY_KEYS].sort(), doEsquema, 'chave de plataforma nova exige atualizar a migration de saneamento (ou uma nova)');
  assert.deepEqual(migracao.PLATFORM_PERMISSION_CODES, [...PLATFORM_PERMISSION_CODES]);
});

test('saneamento_remove_permissao_de_plataforma_atribuida_pela_api_e_preserva_a_da_operacao', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const indevido = await papel(tenant, t, { autor: true });
    const legitimo = await papel(tenant, t, { autor: false });
    const antes = Number((await linhas("SELECT count(*) AS n FROM audit.audit_log WHERE action = 'roles.platform_permission_sanitized'", {}, t))[0].n);
    const r = await roda(t);
    assert.ok(r.permissoes >= 1);
    assert.equal(await RolePermission.count({ where: { roleId: indevido.id }, transaction: t }), 0, 'a atribuída pela API sai');
    assert.equal(await RolePermission.count({ where: { roleId: legitimo.id }, transaction: t }), 1, 'a da operação fica');
    const depois = Number((await linhas("SELECT count(*) AS n FROM audit.audit_log WHERE action = 'roles.platform_permission_sanitized'", {}, t))[0].n);
    assert.equal(depois - antes, r.permissoes, 'cada remoção deixa uma linha de auditoria');
    const again = await roda(t);
    assert.equal(again.permissoes, 0, 'idempotente');
  });
});

test('saneamento_remove_parametro_de_plataforma_gravado_por_quem_nao_e_operador_e_preserva_o_do_operador_e_o_sem_autor', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ins = (key, updatedBy) => sequelize.query(
      `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, updated_by, created_at, updated_at)
       VALUES (gen_random_uuid(), :g, :c, :key, '"x.example.com"'::jsonb, :u, now(), now())
       ON CONFLICT (company_id, key) DO UPDATE SET updated_by = EXCLUDED.updated_by, deleted_at = NULL`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, key, u: updatedBy }, transaction: t });
    const leitura = async (key) => (await linhas('SELECT updated_by FROM core.tenant_settings WHERE company_id = :c AND key = :key', { c: tenant.companyId, key }, t));
    // (a) gravado pelo ADMIN da empresa (não é operador): sai.
    await ins(CHAVE, tenant.userId);
    await roda(t);
    assert.equal((await leitura(CHAVE)).length, 0, 'valor do ADMIN sai e a chave volta ao padrão');
    // (b) sem autor (seed): fica.
    await ins(CHAVE, null);
    await roda(t);
    assert.equal((await leitura(CHAVE)).length, 1);
    // (d) chave que não é de plataforma nunca é tocada, mesmo gravada por quem não é operador.
    await ins('mfa.step_up_ttl_minutes', tenant.userId);
    await roda(t);
    assert.equal((await leitura('mfa.step_up_ttl_minutes')).length, 1);
    // (c) gravado por operador de plataforma (vínculo ativo em papel concedido pela operação): fica.
    await sequelize.query('DELETE FROM core.tenant_settings WHERE company_id = :c AND key = :key', { replacements: { c: tenant.companyId, key: CHAVE }, transaction: t });
    const operador = await papel(tenant, t, { autor: false });
    await UserMembership.create({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roleId: operador.id, status: 'ACTIVE' }, { transaction: t });
    await ins(CHAVE, tenant.userId);
    await roda(t);
    assert.equal((await leitura(CHAVE)).length, 1, 'valor do operador de plataforma é preservado');
  });
});
