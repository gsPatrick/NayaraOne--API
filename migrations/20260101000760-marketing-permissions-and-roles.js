'use strict';

/**
 * M9-D402 — 12 permissões `marketing:*`, os 3 papéis padrão (Assistente de Marketing, Gerente de Marketing, Diretoria) e a
 * concessão padrão. Mesma lista de src/features/marketing/marketing.permissions.js (o teste m9d402 confere que coincidem).
 *
 *  - Permissões: idempotentes por código.
 *  - Papéis: criados por empresa quando nenhum papel da empresa tem um dos nomes da faixa (padrões dos parâmetros
 *    marketing.permissoes.perfis_*); empresas criadas depois usam POST /governance/permissions/apply-default.
 *  - Concessão: ADMIN recebe as 12; Assistente: content:read e write; Gerente: + approve, publish, campaign:manage,
 *    automation:manage e automation:publish; Diretoria: Gerente + killswitch:manage. Só concede, nunca retira.
 *  - Não cria tabela nem role de banco; nenhum GRANT aqui (a guarda de existência do role nayara_runtime vale para quem criar tabela).
 * core.companies e core.roles têm FORCE RLS: a concessão cross-tenant desliga o FORCE só durante a migration e o religa no `finally`.
 */
const PERMISSIONS = [
  ['marketing:content:read', 'Consultar conteúdos, publicações e templates de Marketing.', 'LOW'],
  ['marketing:content:write', 'Criar e editar rascunhos de conteúdo de Marketing (não aprova nem publica).', 'MEDIUM'],
  ['marketing:content:approve', 'Aprovar ou rejeitar a versão corrente de um conteúdo de Marketing.', 'HIGH'],
  ['marketing:content:publish', 'Agendar, publicar e cancelar publicações de conteúdo aprovado.', 'HIGH'],
  ['marketing:template:manage', 'Gerir templates versionados e a lista de campos publicáveis.', 'MEDIUM'],
  ['marketing:campaign:manage', 'Criar, completar e agendar campanhas de Marketing.', 'HIGH'],
  ['marketing:automation:manage', 'Criar, pausar e configurar automações e parâmetros do motor de regras de Marketing.', 'HIGH'],
  ['marketing:automation:publish', 'Publicar ou retomar a versão de uma automação de Marketing.', 'HIGH'],
  ['marketing:suppression:manage', 'Gerir a lista de supressão (opt-out) de Marketing.', 'HIGH'],
  ['marketing:send:mass', 'Disparar mensagem em massa acima do limite sem aprovação.', 'CRITICAL'],
  ['marketing:attribution:read', 'Consultar a atribuição de campanhas (first e last touch).', 'LOW'],
  ['marketing:killswitch:manage', 'Ligar e desligar o kill switch de Marketing; a reativação exige MFA e libera canal para produção.', 'CRITICAL'],
];
const CODES = PERMISSIONS.map(([code]) => code);

const ASSISTENTE_CODES = ['marketing:content:read', 'marketing:content:write'];
const GERENTE_CODES = [...ASSISTENTE_CODES, 'marketing:content:approve', 'marketing:content:publish', 'marketing:campaign:manage', 'marketing:automation:manage', 'marketing:automation:publish'];
const DIRETORIA_CODES = [...GERENTE_CODES, 'marketing:killswitch:manage'];

// Faixas: nome com que o papel é criado e nomes (maiúsculas) que o identificam (padrão dos parâmetros).
const TIERS = [
  { name: 'Assistente de Marketing', names: ['ASSISTENTE DE MARKETING'], codes: ASSISTENTE_CODES },
  { name: 'Gerente de Marketing', names: ['GERENTE DE MARKETING'], codes: GERENTE_CODES },
  { name: 'Diretoria', names: ['DIRETORIA'], codes: DIRETORIA_CODES },
];

module.exports = {
  PERMISSIONS,
  CODES,
  TIERS,

  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });

      for (const [code, description, risk] of PERMISSIONS) {
        // eslint-disable-next-line no-await-in-loop
        await q(
          `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
           SELECT gen_random_uuid(), :code, :description, :risk, now(), now()
            WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = :code)`,
          { code, description, risk }
        );
      }

      await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
      try {
        const grant = (roleFilter, codes, replacements = {}) => q(
          `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
           SELECT gen_random_uuid(), r.id, p.id, now(), now()
             FROM core.roles r CROSS JOIN core.permissions p
            WHERE r.deleted_at IS NULL AND ${roleFilter}
              AND p.code = ANY(ARRAY[:codes])
              AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
          { codes, ...replacements }
        );
        for (const tier of TIERS) {
          // eslint-disable-next-line no-await-in-loop
          await q(
            `INSERT INTO core.roles (id, group_id, company_id, name, description, is_system, created_at, updated_at)
             SELECT gen_random_uuid(), c.group_id, c.id, :name, :description, false, now(), now()
               FROM core.companies c
              WHERE NOT EXISTS (
                SELECT 1 FROM core.roles r
                 WHERE r.company_id = c.id AND r.deleted_at IS NULL AND upper(r.name) = ANY(ARRAY[:names])
              )`,
            { name: tier.name, description: `Papel padrão de Marketing (${tier.name}).`, names: tier.names }
          );
          // eslint-disable-next-line no-await-in-loop
          await grant('upper(r.name) = ANY(ARRAY[:names])', tier.codes, { names: tier.names });
        }
        await grant("r.name = 'ADMIN'", CODES);
      } finally {
        await q('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
        await q('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
      }
    });
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = ANY(ARRAY[:codes]))', { codes: CODES });
      await q('DELETE FROM core.permissions WHERE code = ANY(ARRAY[:codes])', { codes: CODES });
    });
  },
};
