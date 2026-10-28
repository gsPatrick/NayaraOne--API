'use strict';

/**
 * M9-D004 — ai.agents (uma linha por versão de agente) e ai.agent_tools (allowlist de tools por versão).
 *
 * - company_id/group_id NULL = padrão do sistema (os oito agentes do livro, em DRAFT e desabilitados). A RLS FORCE deixa toda
 *   empresa LER o padrão e só escrever as próprias linhas; ninguém escreve no padrão pela aplicação.
 * - Unicidade (company_id, code, version) e no máximo uma versão ACTIVE por (company_id, code) por índices que tratam o
 *   NULL do sistema como um valor (coalesce com o uuid nulo).
 * - Gatilhos: versão fora de DRAFT é imutável, transições só no ciclo DRAFT > HOMOLOGATED > ACTIVE > RETIRED, ativar exige
 *   homologação, allowlist só muda com o agente em DRAFT.
 * - GRANT ao nayara_runtime só se o role existir. Idempotente numa transação; o down recusa se houver agente de empresa.
 */
const { criarFuncoesAgentes } = require('./_helpers/aiAgentsFunctions');
const { linhasDoSeed } = require('./_helpers/aiAgentsSeed');

const NIL = "'00000000-0000-0000-0000-000000000000'::uuid";
const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by uuid NULL,
  updated_by uuid NULL`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await criarFuncoesAgentes(q);

      await q(`CREATE TABLE IF NOT EXISTS ai.agents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(60) NOT NULL,
        version integer NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'DRAFT',
        purpose text NOT NULL,
        system_policy text NOT NULL DEFAULT '',
        model_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
        permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
        data_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
        limits jsonb NOT NULL DEFAULT '{}'::jsonb,
        criticality varchar(12) NOT NULL DEFAULT 'NON_CRITICAL',
        enabled boolean NOT NULL DEFAULT false,
        config_hash char(64) NOT NULL,
        idempotency_key varchar(200) NULL,
        created_from_version integer NULL,
        homologated_by uuid NULL,
        homologated_at timestamptz NULL,
        homologation_note text NULL,
        activated_by uuid NULL,
        activated_at timestamptz NULL,
        retired_by uuid NULL,
        retired_at timestamptz NULL,${AUDIT},
        CONSTRAINT agents_scope_chk CHECK ((company_id IS NULL) = (group_id IS NULL)),
        CONSTRAINT agents_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
        CONSTRAINT agents_version_chk CHECK (version >= 1),
        CONSTRAINT agents_status_chk CHECK (status IN ('DRAFT', 'HOMOLOGATED', 'ACTIVE', 'RETIRED')),
        CONSTRAINT agents_purpose_chk CHECK (length(btrim(purpose)) > 0),
        CONSTRAINT agents_criticality_chk CHECK (criticality IN ('CRITICAL', 'NON_CRITICAL')),
        CONSTRAINT agents_model_policy_chk CHECK (jsonb_typeof(model_policy) = 'object'),
        CONSTRAINT agents_permissions_chk CHECK (jsonb_typeof(permissions) = 'array'),
        CONSTRAINT agents_data_scopes_chk CHECK (jsonb_typeof(data_scopes) = 'array'),
        CONSTRAINT agents_limits_chk CHECK (jsonb_typeof(limits) = 'object'),
        CONSTRAINT agents_hash_chk CHECK (config_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT agents_homologation_chk CHECK (status NOT IN ('HOMOLOGATED', 'ACTIVE') OR (homologated_by IS NOT NULL AND homologated_at IS NOT NULL)),
        CONSTRAINT agents_active_enabled_chk CHECK (status <> 'ACTIVE' OR enabled)
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_company_code_version_uq ON ai.agents (coalesce(company_id, ${NIL}), code, version)`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_one_active_uq ON ai.agents (coalesce(company_id, ${NIL}), code) WHERE status = 'ACTIVE'`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_idempotency_uq ON ai.agents (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS ai_agents_company_code_idx ON ai.agents (company_id, code, status)');
      await q('CREATE INDEX IF NOT EXISTS ai_agents_group_idx ON ai.agents (group_id)');

      await q(`CREATE TABLE IF NOT EXISTS ai.agent_tools (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        agent_id uuid NOT NULL REFERENCES ai.agents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        tool_name varchar(100) NOT NULL,
        permission_code varchar(100) NOT NULL,
        risk_level varchar(10) NOT NULL DEFAULT 'LOW',
        requires_human_approval boolean NOT NULL DEFAULT false,
        enabled boolean NOT NULL DEFAULT true,${AUDIT},
        CONSTRAINT agent_tools_scope_chk CHECK ((company_id IS NULL) = (group_id IS NULL)),
        CONSTRAINT agent_tools_agent_tool_uq UNIQUE (agent_id, tool_name),
        CONSTRAINT agent_tools_name_chk CHECK (length(btrim(tool_name)) > 0),
        CONSTRAINT agent_tools_permission_chk CHECK (length(btrim(permission_code)) > 0),
        CONSTRAINT agent_tools_risk_chk CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT agent_tools_high_approval_chk CHECK (risk_level NOT IN ('HIGH', 'CRITICAL') OR requires_human_approval)
      )`);
      await q('CREATE INDEX IF NOT EXISTS ai_agent_tools_agent_idx ON ai.agent_tools (agent_id)');
      await q('CREATE INDEX IF NOT EXISTS ai_agent_tools_company_idx ON ai.agent_tools (company_id)');

      // Seed do sistema ANTES de ligar o FORCE (padrão das migrations deste projeto), sempre como v1 DRAFT desabilitado.
      for (const a of linhasDoSeed()) {
        await q(
          `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, system_policy, model_policy, data_scopes, limits, criticality, enabled, config_hash)
           SELECT gen_random_uuid(), NULL, NULL, :code, 1, 'DRAFT', :purpose, '', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, :criticality, false, :hash
            WHERE NOT EXISTS (SELECT 1 FROM ai.agents WHERE company_id IS NULL AND code = :code AND version = 1)`,
          { code: a.code, purpose: a.purpose, criticality: a.criticality, hash: a.configHash }
        );
      }

      await q('DROP TRIGGER IF EXISTS agents_guard ON ai.agents');
      await q('CREATE TRIGGER agents_guard BEFORE INSERT OR UPDATE OR DELETE ON ai.agents FOR EACH ROW EXECUTE FUNCTION ai.agents_guard()');
      await q('DROP TRIGGER IF EXISTS agent_tools_sync_permissions ON ai.agent_tools');
      await q(`CREATE TRIGGER agent_tools_sync_permissions AFTER INSERT OR UPDATE OR DELETE ON ai.agent_tools
        FOR EACH ROW EXECUTE FUNCTION ai.agent_tools_sync_permissions()`);
      await q('DROP TRIGGER IF EXISTS agent_tools_guard ON ai.agent_tools');
      await q('CREATE TRIGGER agent_tools_guard BEFORE INSERT OR UPDATE OR DELETE ON ai.agent_tools FOR EACH ROW EXECUTE FUNCTION ai.agent_tools_guard()');

      for (const t of ['agents', 'agent_tools']) {
        await q(`ALTER TABLE ai.${t} ENABLE ROW LEVEL SECURITY`);
        await q(`ALTER TABLE ai.${t} FORCE ROW LEVEL SECURITY`);
        await q(`DROP POLICY IF EXISTS tenant_isolation ON ai.${t}`);
        await q(`CREATE POLICY tenant_isolation ON ai.${t}
          USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
                 AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
        await q(`DROP POLICY IF EXISTS system_default_read ON ai.${t}`);
        await q(`CREATE POLICY system_default_read ON ai.${t} FOR SELECT USING (group_id IS NULL AND company_id IS NULL)`);
      }

      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE ON ai.agents TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ai.agent_tools TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.agents NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.agent_tools NO FORCE ROW LEVEL SECURITY');
      const [[{ n }]] = await q('SELECT count(*)::int AS n FROM ai.agents WHERE company_id IS NOT NULL');
      if (n > 0) throw new Error('ai.agents tem versões de empresa; apague-as de propósito antes de reverter a migration.');
      await q('DROP TABLE IF EXISTS ai.agent_tools');
      await q('ALTER TABLE ai.agents DISABLE TRIGGER agents_guard');
      await q('DROP TABLE IF EXISTS ai.agents');
      await q('DROP FUNCTION IF EXISTS ai.agent_tools_sync_permissions()');
      await q('DROP FUNCTION IF EXISTS ai.agent_tools_guard()');
      await q('DROP FUNCTION IF EXISTS ai.agents_guard()');
    });
  },
};
