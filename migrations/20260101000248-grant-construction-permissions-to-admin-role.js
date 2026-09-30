'use strict';

/**
 * BUG REAL CRÍTICO CORRIGIDO (30/09/2026, achado numa nova rodada de verificação de
 * integrações do Marco 6 — releitura do contrato + checagem cruzada com o sistema de
 * permissões/IAM): as permissões `construction:*` foram seedadas em
 * `20260101000100-seed-construction-permissions.js`, mas NUNCA foram concedidas ao papel
 * ADMIN. Sem esta migration, TODO endpoint do módulo de Obras responde 403 pra qualquer
 * usuário, inclusive o administrador — o módulo inteiro fica inacessível pela API apesar do
 * código estar 100% funcional.
 *
 * BUG SECUNDÁRIO ACHADO E CORRIGIDO NO PROCESSO (mais sério do que parecia à primeira vista):
 * `core.companies` e `core.roles` têm RLS `FORCE ROW LEVEL SECURITY` ativo desde o início do
 * schema. Uma migration comum (mesmo padrão da já existente
 * `20260101000176-grant-missing-crm-permissions-to-admin-role.js`) que faz
 * `SELECT ... FROM core.roles`/`core.companies` sem `SET LOCAL app.company_id` primeiro NÃO
 * ENXERGA NENHUMA LINHA — nem `nayara_migration` tem BYPASSRLS (privilégio mínimo mesmo pra
 * DDL) — e pior: pra enumerar as empresas eu precisaria já saber o `company_id`, um problema
 * circular. A INSERT roda "com sucesso" mas afeta ZERO linhas, silenciosamente — SEM ERRO
 * ALGUM, o que faz esse bug passar despercebido em revisão superficial (aconteceu de novo
 * agora comigo antes de eu confirmar com uma query direta).
 *
 * CORREÇÃO: como `nayara_migration` é DONO das tabelas `core.companies`/`core.roles` (dono de
 * schema tem permissão de ALTER mesmo com FORCE RLS ativo), a migration desativa
 * temporariamente `FORCE ROW LEVEL SECURITY` nessas duas tabelas, faz a concessão cross-tenant
 * (é uma operação administrativa legítima — conceder permissão ao papel ADMIN de TODAS as
 * empresas), e reativa `FORCE ROW LEVEL SECURITY` no `finally` (garantido mesmo se a concessão
 * falhar no meio). Idempotente (`NOT EXISTS`) — seguro rodar mais de uma vez.
 */
const CODES = ['construction:create', 'construction:read', 'construction:update', 'construction:approve', 'construction:delete'];

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
