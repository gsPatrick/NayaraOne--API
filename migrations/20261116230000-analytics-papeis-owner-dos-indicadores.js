'use strict';

/**
 * DI-BI2-10 — papéis de owner dos indicadores do BI (16/11/2026). O owner padrão de cada indicador (`analytics.owner.<código>`, "Área (papel código)") apontava
 * para papéis que nenhuma migration nem semente criava, e com códigos divergentes para a mesma área ("jurídico-gestor" e "juridico-gestor", "locação-gestor",
 * "tecnologia-gestor", "ia-gestor" e "ti-gestor", "Gestor de Estoque" e "Almoxarifado"). O aceite do owner (M9-D708) procura o papel pelo nome: sem papel, nenhum
 * owner padrão era reconhecido. Esta migration:
 *  - cria em cada empresa os 10 papéis do catálogo (src/features/analytics/read-models/owner.roles.js) que ainda não existem (nome igual, sem diferenciar
 *    maiúsculas), com as permissões do owner (analytics:read e analytics:accept); papel existente não é tocado;
 *  - troca os textos padrão antigos pelo texto do catálogo onde ficaram gravados: parâmetro da empresa com exatamente o texto antigo, definição publicada do
 *    indicador, linha da fila de decisão e as duas definições do catálogo global que usavam "tecnologia-gestor" e "ia-gestor". Texto escolhido pelo administrador
 *    (diferente do padrão antigo) fica como está.
 * core.companies, core.roles, core.tenant_settings e as tabelas do BI têm FORCE RLS: desligado só durante a migration e religado no `finally`. Idempotente.
 */
const { OWNER_ROLES, OWNER_ROLE_CODES, LEGACY_OWNER_TEXTS, OWNER_ROLE_PERMISSIONS, ownerRoleDescription } = require('../src/features/analytics/read-models/owner.roles');

const FORCED = ['core.companies', 'core.roles', 'core.tenant_settings', 'analytics.metric_definitions', 'analytics.rm_decision_queue'];
const GLOBAL_CODES = Object.freeze({ 'tec.rule_approvals_pending': 'tecnologia-gestor', 'ai.proposals_pending': 'ia-gestor' });

async function seedRoles(q) {
  for (const code of OWNER_ROLE_CODES) {
    const created = await q(
      `INSERT INTO core.roles (id, group_id, company_id, name, description, is_system, created_at, updated_at)
       SELECT gen_random_uuid(), c.group_id, c.id, :code, :description, false, now(), now()
         FROM core.companies c
        WHERE NOT EXISTS (SELECT 1 FROM core.roles r WHERE r.company_id = c.id AND r.deleted_at IS NULL AND upper(r.name) = upper(:code))
       RETURNING id`,
      { code, description: ownerRoleDescription(code) }
    );
    const ids = created[0].map((r) => r.id);
    if (!ids.length) continue;
    await q(
      `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
       SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
        WHERE r.id = ANY(ARRAY[:ids]::uuid[]) AND p.code = ANY(ARRAY[:codes])
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
      { ids, codes: [...OWNER_ROLE_PERMISSIONS] }
    );
  }
}

async function fixLegacyTexts(q) {
  for (const [old, now] of Object.entries(LEGACY_OWNER_TEXTS)) {
    await q("UPDATE core.tenant_settings SET value = to_jsonb(CAST(:now AS text)), updated_at = now() WHERE key LIKE 'analytics.owner.%' AND value = to_jsonb(CAST(:old AS text))", { old, now });
    await q('UPDATE analytics.metric_definitions SET owner_role = :now, updated_at = now() WHERE owner_role = :old', { old, now });
    await q('UPDATE analytics.rm_decision_queue SET owner_role = :now WHERE owner_role = :old', { old, now });
  }
  for (const [metricCode, old] of Object.entries(GLOBAL_CODES)) {
    await q('UPDATE analytics.metric_definitions SET owner_role = :now, updated_at = now() WHERE company_id IS NULL AND metric_code = :metricCode AND owner_role = :old', { metricCode, old, now: 'ti-gestor' });
  }
}

module.exports = {
  OWNER_ROLES,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q("SELECT set_config('app.analytics_writer', 'on', true)");
      for (const t of FORCED) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      try {
        await seedRoles(q);
        await fixLegacyTexts(q);
      } finally {
        for (const t of FORCED) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      }
    });
  },

  // Os papéis criados podem já ter membros e o texto antigo era o erro: a volta não apaga papel nem restaura texto divergente.
  async down() {},
};
