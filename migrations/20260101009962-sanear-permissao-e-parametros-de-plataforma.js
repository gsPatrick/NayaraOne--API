'use strict';

/**
 * Marco 9, M9-D200 (reabertura R4-L2) — saneamento do que foi atribuído ou gravado ANTES das travas de plataforma (R3-M1, R3-M2).
 * Idempotente; cada correção deixa uma linha em audit.audit_log (com o valor anterior) para a equipe da plataforma conferir.
 *
 * Critério (DI-D200-R4): permissão de plataforma legítima é a concedida pela operação da plataforma direto no banco (role_permissions.created_by NULO);
 * a concedida pela API de empresa grava o autor (created_by preenchido) e é indevida.
 *  1) role_permissions de permissão de plataforma com created_by preenchido: removidas (auditoria roles.platform_permission_sanitized).
 *  2) tenant_settings das chaves só da plataforma gravadas por usuário que NÃO é operador de plataforma (vínculo ativo em papel com permissão de plataforma
 *     concedida pela operação): removidas, a chave volta ao padrão (auditoria settings.platform_key_sanitized). Linhas sem autor (seed) ficam.
 * Sem tabela nova (nada de RLS/GRANT novo). As listas abaixo acompanham SETTINGS_SCHEMA (platformOnly) e src/shared/platform-permissions; um teste confere a igualdade.
 */
const PLATFORM_PERMISSION_CODES = ['integration:platform'];
const PLATFORM_ONLY_KEYS = [
  'integration.secret.require_company_prefix', 'integration.egress.mode', 'integration.ssrf.allowed_schemes', 'integration.ssrf.max_redirects',
  'integration.ssrf.max_bytes', 'integration.ssrf.fetch_allowlist', 'integration.ssrf.timeout_ms', 'integration.ssrf.allowed_ports',
  'integration.ssrf.content_types', 'integration.egress.provider_hosts', 'integration.egress.private_hosts',
];

const OPERADORES = `SELECT DISTINCT m.user_id FROM core.user_memberships m
  JOIN core.role_permissions rp ON rp.role_id = m.role_id AND rp.created_by IS NULL
  JOIN core.permissions p ON p.id = rp.permission_id AND p.code = ANY(ARRAY[:codes]::text[])
  WHERE m.status = 'ACTIVE' AND m.deleted_at IS NULL`;

const AUDITORIA = `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
  VALUES (gen_random_uuid(), :g, :c, NULL, :action, :tipo, :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`;

/** `q(sql, replacements)` roda dentro de uma transação já aberta (migration e teste). Devolve o que foi saneado. */
async function sanear(q) {
  const codes = PLATFORM_PERMISSION_CODES;
  const [papeis] = await q(
    `SELECT rp.id AS rp_id, rp.role_id, r.group_id, r.company_id, r.name, p.code, rp.created_by
       FROM core.role_permissions rp JOIN core.permissions p ON p.id = rp.permission_id JOIN core.roles r ON r.id = rp.role_id
      WHERE p.code = ANY(ARRAY[:codes]::text[]) AND rp.created_by IS NOT NULL`, { codes });
  const [chaves] = await q(
    `SELECT id, group_id, company_id, key, value, updated_by FROM core.tenant_settings
      WHERE key = ANY(ARRAY[:keys]::text[]) AND updated_by IS NOT NULL AND updated_by NOT IN (${OPERADORES})`, { keys: PLATFORM_ONLY_KEYS, codes });
  for (const r of papeis) {
    await q(AUDITORIA, {
      g: r.group_id, c: r.company_id, action: 'roles.platform_permission_sanitized', tipo: 'Role', id: r.role_id,
      b: JSON.stringify({ roleName: r.name, permission: r.code, grantedBy: r.created_by }), a: JSON.stringify({ roleName: r.name, permission: null }),
      r: 'Migration 20260101009962: permissão de plataforma atribuída pela API de empresa (indevida) removida do papel.',
    });
    await q('DELETE FROM core.role_permissions WHERE id = :id', { id: r.rp_id });
  }
  for (const k of chaves) {
    await q(AUDITORIA, {
      g: k.group_id, c: k.company_id, action: 'settings.platform_key_sanitized', tipo: 'TenantSetting', id: k.id,
      b: JSON.stringify({ key: k.key, value: k.value, updatedBy: k.updated_by }), a: JSON.stringify({ key: k.key, value: null }),
      r: 'Migration 20260101009962: parâmetro só da plataforma gravado por quem não é operador de plataforma; volta ao padrão.',
    });
    await q('DELETE FROM core.tenant_settings WHERE id = :id', { id: k.id });
  }
  return { permissoes: papeis.length, parametros: chaves.length };
}

const TABELAS = ['core.roles', 'core.tenant_settings', 'audit.audit_log'];

module.exports = {
  up: async (queryInterface) => {
    const s = queryInterface.sequelize;
    await s.transaction(async (transaction) => {
      const q = (sql, replacements) => s.query(sql, { replacements, transaction });
      for (const t of TABELAS) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await sanear(q);
      for (const t of TABELAS) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
  },
  down: async () => {}, // saneamento não se desfaz; o valor anterior está na auditoria
  sanear, PLATFORM_ONLY_KEYS, PLATFORM_PERMISSION_CODES,
};
