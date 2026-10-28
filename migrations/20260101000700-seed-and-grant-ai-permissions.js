'use strict';

/**
 * M9-D003 — Permissões da NAY (8 códigos ai:*) e concessão ao perfil ADMIN.
 * Mesma lista de src/features/ai/ai.permissions.js (cópia literal; o teste m9d003 confere). ADMIN recebe 7 das 8; `ai:restricted`
 * (conteúdo RESTRICTED no contexto da NAY) só por concessão explícita (DI-300). O role de runtime já lê core.permissions por
 * privilégio existente; o GRANT abaixo só é emitido se o role existir. Idempotente e reversível.
 * core.roles tem FORCE RLS: a concessão cross-tenant desliga o FORCE só durante a migration (padrão das migrations 248, 633 e 800).
 */
const PERMISSIONS = [
  ['ai:use', 'Criar run e conversar com agente da NAY.', 'LOW'],
  ['ai:read', 'Ver os próprios runs e as recomendações da NAY dirigidas ao usuário.', 'LOW'],
  ['ai:audit', 'Ver runs, fontes e tool calls da NAY de toda a empresa.', 'MEDIUM'],
  ['ai:approve', 'Aceitar ou rejeitar recomendação da NAY (além da permissão da ação alvo).', 'HIGH'],
  ['ai:admin', 'Administrar agentes, tools, providers, base de conhecimento e a chave geral da NAY.', 'CRITICAL'],
  ['ai:budget', 'Editar os orçamentos de uso da NAY.', 'HIGH'],
  ['ai:evaluate', 'Rodar avaliações e homologar versões da NAY.', 'MEDIUM'],
  ['ai:restricted', 'Permitir que conteúdo RESTRICTED entre no contexto da NAY.', 'CRITICAL'],
];
const CODES = PERMISSIONS.map(([code]) => code);
const ADMIN_CODES = CODES.filter((code) => code !== 'ai:restricted');

module.exports = {
  PERMISSIONS,
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
      await q(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT SELECT ON core.permissions TO nayara_runtime;
          END IF;
        END $$;
      `);
      await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
      try {
        await q(
          `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
           SELECT gen_random_uuid(), r.id, p.id, now(), now()
             FROM core.roles r CROSS JOIN core.permissions p
            WHERE r.name = 'ADMIN' AND p.code = ANY(ARRAY[:codes])
              AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
          { codes: ADMIN_CODES }
        );
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
