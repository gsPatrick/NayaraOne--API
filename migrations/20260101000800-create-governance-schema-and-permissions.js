'use strict';

/**
 * M9-D800 — Alicerce da governança: schema `governance`, função padrão de RLS, 21 permissões `governance:*` e concessão padrão.
 *
 *  - Schema `governance` (sem tabelas nesta migration; cada demanda cria as suas, na faixa 20260101000800-869 do bloco E e
 *    870-899 do bloco F).
 *  - `governance.apply_tenant_rls(regclass)`: toda tabela de governança chama esta função na sua migration. Ela liga RLS + FORCE RLS,
 *    cria a política `tenant_isolation` (USING e WITH CHECK por company_id) e dá o GRANT ao role de runtime SOMENTE se ele existir.
 *  - Catálogo fechado de 21 permissões (mesma lista de src/modules/core-governance/governance.permissions.js) e a tabela de
 *    concessão padrão: ADMIN recebe as 21; perfis de Gestão (6), Financeiro (5) e os demais (só calendar:read). Os nomes dos perfis
 *    de Gestão/Financeiro usam os padrões do parâmetro; depois da migration o administrador pode reaplicar com os nomes que
 *    escolher (POST /governance/permissions/apply-default).
 *
 * Idempotente (reexecutável sem erro), em transação única, reversível (`down`). core.companies e core.roles têm FORCE RLS: a
 * concessão cross-tenant desliga o FORCE só durante a migration (padrão das migrations 248 e 633) e o religa no `finally`.
 */
const PERMISSIONS = [
  ['governance:calendar:read', 'Consultar o calendário unificado de governança.', 'LOW'],
  ['governance:data-quality:read', 'Consultar donos, curadores e problemas de qualidade de dados.', 'LOW'],
  ['governance:data-quality:manage', 'Gerir donos/curadores de dados e tratar problemas de qualidade.', 'MEDIUM'],
  ['governance:data-quality:bulk', 'Executar alteração em massa de dados mestres (exige permissão, MFA e auditoria).', 'CRITICAL'],
  ['governance:lineage:manage', 'Gerir o registro de linhagem de dados e KPIs críticos.', 'HIGH'],
  ['governance:dlp:export', 'Solicitar exportação de dados sujeita às regras de DLP.', 'MEDIUM'],
  ['governance:dlp:admin', 'Administrar políticas de DLP e liberar exportações bloqueadas.', 'CRITICAL'],
  ['governance:dlp:view-restricted', 'Ver em claro campos classificados como RESTRICTED (única permissão dedicada).', 'CRITICAL'],
  ['governance:bcp:record', 'Registrar operação manual de contingência (BCP).', 'MEDIUM'],
  ['governance:bcp:import', 'Importar operações manuais de contingência para o sistema.', 'HIGH'],
  ['governance:bcp:approve', 'Aprovar operações manuais de contingência importadas.', 'CRITICAL'],
  ['governance:api:read', 'Consultar consumidores, contratos e versões de API.', 'LOW'],
  ['governance:api:manage', 'Gerir consumidores, depreciações e contratos de API.', 'HIGH'],
  ['governance:finops:read', 'Consultar custos, orçamentos e saúde de FinOps.', 'LOW'],
  ['governance:finops:manage', 'Gerir orçamentos, alertas e coletores de FinOps.', 'HIGH'],
  ['governance:flags:manage', 'Gerir feature flags, configurações e kill switches.', 'CRITICAL'],
  ['governance:migration:run', 'Executar etapas da migração de dados do sistema legado.', 'CRITICAL'],
  ['governance:migration:admin', 'Administrar a migração de dados (corte, reversão, exceções).', 'CRITICAL'],
  ['governance:classification:manage', 'Gerir a classificação de dados (PUBLIC a RESTRICTED).', 'HIGH'],
  ['governance:retention:manage', 'Gerir políticas de retenção e descarte de dados.', 'HIGH'],
  ['governance:legal-hold:manage', 'Criar e liberar bloqueio legal (legal hold) de dados.', 'CRITICAL'],
];
const CODES = PERMISSIONS.map(([code]) => code);

const GESTAO_CODES = ['governance:calendar:read', 'governance:data-quality:read', 'governance:data-quality:manage', 'governance:dlp:export', 'governance:api:read', 'governance:finops:read'];
const FINANCEIRO_CODES = ['governance:calendar:read', 'governance:finops:read', 'governance:dlp:export', 'governance:bcp:record', 'governance:bcp:import'];
const OPERACIONAL_CODES = ['governance:calendar:read'];
// Padrões dos parâmetros governanca.permissoes.perfis_gestao / perfis_financeiro (em maiúsculas).
const GESTAO_NAMES = ['GESTAO', 'GESTÃO', 'DIRETOR', 'GERENTE', 'GESTOR'];
const FINANCEIRO_NAMES = ['FINANCEIRO'];

const APPLY_TENANT_RLS_SQL = `
CREATE OR REPLACE FUNCTION governance.apply_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_table;
  IF v_schema IS DISTINCT FROM 'governance' THEN
    RAISE EXCEPTION 'apply_tenant_rls só vale para tabelas do schema governance (recebido: %)', v_schema;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_table AND attname = 'company_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'a tabela % não tem a coluna company_id exigida pela RLS de governança', p_table;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = p_table AND polname = 'tenant_isolation') THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid) WITH CHECK (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid)',
      p_table
    );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO nayara_runtime', p_table);
  END IF;
END
$fn$;
`;

module.exports = {
  PERMISSIONS,
  CODES,

  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });

      await q('CREATE SCHEMA IF NOT EXISTS governance');
      await q(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA governance TO nayara_runtime;
            ALTER DEFAULT PRIVILEGES IN SCHEMA governance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nayara_runtime;
            ALTER DEFAULT PRIVILEGES IN SCHEMA governance GRANT USAGE, SELECT ON SEQUENCES TO nayara_runtime;
          END IF;
        END $$;
      `);
      await q(APPLY_TENANT_RLS_SQL);
      await q('REVOKE ALL ON FUNCTION governance.apply_tenant_rls(regclass) FROM PUBLIC');

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
            WHERE ${roleFilter}
              AND p.code = ANY(ARRAY[:codes])
              AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
          { codes, ...replacements }
        );
        await grant("r.name = 'ADMIN'", CODES);
        await grant('upper(r.name) = ANY(ARRAY[:names])', GESTAO_CODES, { names: GESTAO_NAMES });
        await grant('upper(r.name) = ANY(ARRAY[:names])', FINANCEIRO_CODES, { names: FINANCEIRO_NAMES });
        await grant("r.name <> 'ADMIN' AND upper(r.name) <> ALL(ARRAY[:names])", OPERACIONAL_CODES, { names: [...GESTAO_NAMES, ...FINANCEIRO_NAMES] });
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
      await q('DROP FUNCTION IF EXISTS governance.apply_tenant_rls(regclass)');
      // O schema só cai se estiver vazio: tabelas de demandas posteriores impedem (elas são desfeitas antes, em ordem inversa).
      await q(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'governance') THEN
            DROP SCHEMA IF EXISTS governance;
          END IF;
        END $$;
      `);
    });
  },
};
