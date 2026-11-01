'use strict';

// Marco 9, M9-D200 (reabertura R5-L2) — o relatório da migration 9963 cobre uma chave de CADA família protegida do registro (sem alterar o valor) e não acusa quem tem a permissão,
// a chave comum nem o valor sem autor.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const saneamento = require('../../../migrations/20260101009962-sanear-permissao-e-parametros-de-plataforma');
const relatorio = require('../../../migrations/20260101009963-relatorio-saneamento-chaves-protegidas');
const { Permission, Role, RolePermission, UserMembership } = require('../../../src/models');

after(async () => { await sequelize.close(); });

const PLATAFORMA = saneamento.PLATFORM_PERMISSION_CODES[0];
const q = (t) => (sql, replacements) => sequelize.query(sql, { replacements, transaction: t });
const linhas = async (t, sql, replacements) => (await sequelize.query(sql, { replacements, transaction: t }))[0];
const contaAuditoria = async (t, action, entityId) => Number((await linhas(t, 'SELECT count(*) AS n FROM audit.audit_log WHERE action = :a AND entity_id = :e', { a: action, e: entityId }))[0].n);

async function papel(tenant, t, { criadoPor, permissao = PLATAFORMA, autorDaPermissao = null }) {
  const p = await Permission.findOne({ where: { code: permissao }, transaction: t });
  assert.ok(p, `a permissão ${permissao} existe no catálogo`);
  const r = await Role.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: `QA-M9 ${uniqueSuffix()}`, isSystem: false, createdBy: criadoPor }, { transaction: t });
  await RolePermission.create({ roleId: r.id, permissionId: p.id, createdBy: autorDaPermissao }, { transaction: t });
  return r;
}

const gravarParametro = (tenant, t, key, updatedBy, value = '7') => sequelize.query(
  `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, updated_by, created_at, updated_at)
   VALUES (gen_random_uuid(), :g, :c, :key, :v::jsonb, :u, now(), now())
   ON CONFLICT (company_id, key) DO UPDATE SET updated_by = EXCLUDED.updated_by, value = EXCLUDED.value, deleted_at = NULL RETURNING id`,
  { replacements: { g: tenant.groupId, c: tenant.companyId, key, v: value, u: updatedBy }, transaction: t }).then(([[l]]) => l.id);

/** Uma chave de cada permissão exigida (as 19 famílias do registro de chaves protegidas). */
function chavesPorFamilia() {
  const porPermissao = new Map();
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    const exigida = restrictedPermissionOf(key);
    if (exigida && !porPermissao.has(exigida)) porPermissao.set(exigida, key);
  }
  return porPermissao;
}

test('saneamento_r5_relata_valor_de_toda_familia_protegida_sem_alterar', async () => {
  const tenant = await getSeedTenant();
  const familias = chavesPorFamilia();
  assert.ok(familias.size >= 18, `as famílias protegidas aparecem no registro (${familias.size})`);
  await withRollbackTenantTransaction(tenant, async (t) => {
    const autorSemPermissao = crypto.randomUUID();
    const ids = new Map();
    for (const [permissao, key] of familias) ids.set(permissao, await gravarParametro(tenant, t, key, autorSemPermissao));
    const r = await relatorio.relatar(q(t), restrictedPermissionOf);
    assert.ok(r.relatadas >= familias.size);
    for (const [permissao, key] of familias) {
      const id = ids.get(permissao);
      assert.equal(await contaAuditoria(t, 'settings.protected_key_review', id), 1, `${key} (${permissao}) entra no relatório`);
      const [reg] = await linhas(t, "SELECT before_json FROM audit.audit_log WHERE action = 'settings.protected_key_review' AND entity_id = :e", { e: id });
      assert.equal(reg.before_json.requiredPermission, permissao);
      assert.equal(reg.before_json.key, key);
      assert.equal((await linhas(t, 'SELECT value FROM core.tenant_settings WHERE id = :id', { id }))[0].value, 7, 'o valor continua em vigor: relatar não altera');
    }
    assert.equal((await relatorio.relatar(q(t), restrictedPermissionOf)).relatadas, 0, 'idempotente');
  });
});

test('saneamento_r5_nao_relata_quem_tem_a_permissao_nem_a_chave_comum_nem_o_sem_autor', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const comPermissao = await papel(tenant, t, { criadoPor: tenant.userId, permissao: 'integration:manage', autorDaPermissao: tenant.userId });
    await UserMembership.create({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roleId: comPermissao.id, status: 'ACTIVE' }, { transaction: t });
    const slo = await gravarParametro(tenant, t, 'integration.slo.CRITICAL', tenant.userId);
    const semAutor = await gravarParametro(tenant, t, 'ia.habilitada', null, 'true');
    const comum = await gravarParametro(tenant, t, 'integration.outbox.backoff_ms', crypto.randomUUID(), '"1000,2000"');
    await relatorio.relatar(q(t), restrictedPermissionOf);
    assert.equal(await contaAuditoria(t, 'settings.protected_key_review', slo), 0, 'quem tem integration:manage gravou a meta de SLO legitimamente');
    assert.equal(await contaAuditoria(t, 'settings.protected_key_review', semAutor), 0, 'valor sem autor (seed) não entra');
    assert.equal(await contaAuditoria(t, 'settings.protected_key_review', comum), 0, 'chave comum não é protegida');
  });
});
