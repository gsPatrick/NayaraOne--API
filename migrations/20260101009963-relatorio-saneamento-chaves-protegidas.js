'use strict';

/**
 * Marco 9, M9-D200 (reabertura R5-L2) — complemento do saneamento da migration 20260101009962. Idempotente; sem tabela nova (nada de RLS/GRANT novo).
 *
 *  1) RELATÓRIO das demais famílias protegidas (Marketing, NAY/ia, SLO, migração, governança, MFA): valor gravado em core.tenant_settings por quem, hoje, NÃO tem a permissão
 *     do dono da chave (a que `restrictedPermissionOf` exige) pode ter entrado por PATCH /feature-flags antes das travas. Nada é apagado nem alterado (apagar mudaria o comportamento
 *     da empresa sem decisão humana): cada linha vira um registro `settings.protected_key_review` em audit.audit_log (chave, valor, autor, permissão exigida), uma vez por linha,
 *     para a equipe da plataforma e o administrador conferirem e, se for o caso, regravarem a chave com a permissão certa.
 *  2) RESTAURAÇÃO: a 9962 original removia a permissão de plataforma do papel do OPERADOR quando um ADMIN o editou antes da trava (as linhas voltavam com autor). O papel criado pela
 *     operação (core.roles.created_by nulo) que perdeu a permissão por essa limpeza (registro `roles.platform_permission_sanitized`) a recebe de volta, com autor nulo
 *     (`roles.platform_permission_restored`, antes e depois). Papel criado por empresa nunca é restaurado.
 */
const AUDITORIA = `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
  VALUES (gen_random_uuid(), :g, :c, NULL, :action, :tipo, :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`;

/** Chaves protegidas presentes em tenant_settings, com a permissão que cada uma exige hoje. */
async function paresProtegidos(q, permissaoDe) {
  const [chaves] = await q('SELECT DISTINCT key FROM core.tenant_settings WHERE deleted_at IS NULL AND updated_by IS NOT NULL');
  return chaves.map((c) => ({ key: c.key, required: permissaoDe(c.key) })).filter((p) => p.required);
}

/** Relata (sem alterar) o valor de chave protegida gravado por quem não tem a permissão do dono. Devolve a quantidade de linhas novas no relatório. */
async function relatar(q, permissaoDe) {
  const pares = await paresProtegidos(q, permissaoDe);
  if (!pares.length) return { relatadas: 0 };
  const [linhas] = await q(
    `SELECT ts.id, ts.group_id, ts.company_id, ts.key, ts.value, ts.updated_by, req.required
       FROM core.tenant_settings ts JOIN jsonb_to_recordset(:pares::jsonb) AS req(key text, required text) ON req.key = ts.key
      WHERE ts.deleted_at IS NULL AND ts.updated_by IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM core.user_memberships m
                          JOIN core.role_permissions rp ON rp.role_id = m.role_id
                          JOIN core.permissions p ON p.id = rp.permission_id AND p.code = req.required
                         WHERE m.user_id = ts.updated_by AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND (m.company_id = ts.company_id OR m.company_id IS NULL))
        AND NOT EXISTS (SELECT 1 FROM audit.audit_log a WHERE a.action = 'settings.protected_key_review' AND a.entity_id = ts.id)`,
    { pares: JSON.stringify(pares) });
  for (const l of linhas) {
    await q(AUDITORIA, {
      g: l.group_id, c: l.company_id, action: 'settings.protected_key_review', tipo: 'TenantSetting', id: l.id,
      b: JSON.stringify({ key: l.key, value: l.value, updatedBy: l.updated_by, requiredPermission: l.required }),
      a: JSON.stringify({ key: l.key, value: l.value, kept: true }),
      r: 'Migration 20260101009963: parâmetro protegido gravado por quem não tem a permissão do dono da chave; mantido. Conferir e regravar com a permissão certa, se for o caso.',
    });
  }
  return { relatadas: linhas.length };
}

/** Devolve a permissão de plataforma ao papel do operador (criado pela operação) que a perdeu na limpeza antiga. */
async function restaurar(q) {
  const [perdidas] = await q(
    `SELECT DISTINCT ON (r.id, p.id) r.id AS role_id, r.group_id, r.company_id, r.name, p.id AS permission_id, p.code
       FROM audit.audit_log a
       JOIN core.roles r ON r.id = a.entity_id AND r.deleted_at IS NULL AND r.created_by IS NULL
       JOIN core.permissions p ON p.code = a.before_json->>'permission'
      WHERE a.action = 'roles.platform_permission_sanitized'
        AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM audit.audit_log b WHERE b.action = 'roles.platform_permission_restored' AND b.entity_id = r.id AND b.after_json->>'permission' = p.code)`);
  for (const r of perdidas) {
    await q('INSERT INTO core.role_permissions (id, role_id, permission_id, created_by, updated_by, created_at, updated_at) VALUES (gen_random_uuid(), :role, :perm, NULL, NULL, now(), now())', { role: r.role_id, perm: r.permission_id });
    await q(AUDITORIA, {
      g: r.group_id, c: r.company_id, action: 'roles.platform_permission_restored', tipo: 'Role', id: r.role_id,
      b: JSON.stringify({ roleName: r.name, permission: null }), a: JSON.stringify({ roleName: r.name, permission: r.code }),
      r: 'Migration 20260101009963: papel do operador (criado pela operação) perdeu a permissão de plataforma na limpeza da migration 9962 original; devolvida.',
    });
  }
  return { restauradas: perdidas.length };
}

const TABELAS = ['core.roles', 'core.tenant_settings', 'audit.audit_log'];

module.exports = {
  up: async (queryInterface) => {
    const s = queryInterface.sequelize;
    const { restrictedPermissionOf } = require('../src/features/settings/settingRestricted');
    await s.transaction(async (transaction) => {
      const q = (sql, replacements) => s.query(sql, { replacements, transaction });
      for (const t of TABELAS) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await restaurar(q);
      await relatar(q, restrictedPermissionOf);
      for (const t of TABELAS) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
  },
  down: async () => {}, // relatório e restauração não se desfazem; o antes e o depois estão na auditoria
  relatar, restaurar,
};
