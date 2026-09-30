'use strict';

/**
 * BUG REAL CRÍTICO CORRIGIDO (30/09/2026, achado numa auditoria do FRONT do Marco 6 — o novo
 * seletor de centro de custo em "Nova obra"/"Editar obra" chama GET /finance/cost-centers,
 * requirePermission('finance:read'), e a página inteira falhava pra qualquer usuário,
 * inclusive ADMIN, com "Permissão ausente: finance:read"). Mesma classe de bug já corrigida em
 * 20260101000248 (construction:*): as permissões `finance:*` foram seedadas no catálogo
 * (`20260101000095-seed-remaining-permissions.js`), mas NUNCA foram concedidas ao papel ADMIN
 * em nenhuma migration — nenhum usuário, nem administrador, tem acesso a NENHUM endpoint do
 * módulo Financeiro (lançamentos, centros de custo, contas bancárias, conciliação, aprovação,
 * liquidação) apesar do código estar 100% funcional. Mesmo padrão de correção: `core.roles`/
 * `core.companies` têm FORCE ROW LEVEL SECURITY ativo mesmo pro papel de migração (não
 * BYPASSRLS), então a concessão cross-tenant exige desativar temporariamente o FORCE RLS
 * (nayara_migration é dono das tabelas), conceder, e reativar no finally.
 */
const CODES = [
  'finance:create',
  'finance:read',
  'finance:update',
  'finance:approve',
  'finance:settle',
  'finance:reconcile',
  'finance:bankAccounts',
];

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(
        `
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r
        CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN'
          AND p.code = ANY(ARRAY[:codes])
          AND NOT EXISTS (
            SELECT 1 FROM core.role_permissions rp
            WHERE rp.role_id = r.id AND rp.permission_id = p.id
          )
        `,
        { replacements: { codes: CODES } }
      );
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },

  down: async () => {
    // Concessão de permissão pré-existente não é revertida automaticamente.
  },
};
