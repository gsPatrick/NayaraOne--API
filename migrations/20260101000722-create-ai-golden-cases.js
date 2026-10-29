'use strict';

/**
 * M9-D033 — ai.golden_cases: golden dataset por agente (um caso por linha, versionado). Corrigir um caso cria a versão
 * seguinte; a linha nunca muda, exceto a aposentadoria (ACTIVE para RETIRED, uma vez), e nunca é apagada (AI044).
 * company_id/group_id NULL = caso do sistema (os oito agentes do livro), legível por toda empresa e escrito só aqui.
 * RLS ENABLE + FORCE; GRANT ao nayara_runtime só se o role existir (sem DELETE). Down recusa se houver caso de empresa.
 */
const { linhasDoSeed } = require('./_helpers/aiGoldenSeed');

const NIL = "'00000000-0000-0000-0000-000000000000'::uuid";
const CATEGORIES = ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'INJECTION', 'COST', 'LATENCY'];

const FN_GUARD = `
CREATE OR REPLACE FUNCTION ai.golden_cases_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI_GOLDEN_IMMUTABLE: caso do golden dataset não se apaga; aposente-o' USING ERRCODE = 'AI044';
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.agent_code IS DISTINCT FROM OLD.agent_code
     OR NEW.case_key IS DISTINCT FROM OLD.case_key OR NEW.category IS DISTINCT FROM OLD.category OR NEW.input IS DISTINCT FROM OLD.input
     OR NEW.fixtures IS DISTINCT FROM OLD.fixtures OR NEW.expected IS DISTINCT FROM OLD.expected OR NEW.must_not IS DISTINCT FROM OLD.must_not
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.source_candidate_id IS DISTINCT FROM OLD.source_candidate_id THEN
    RAISE EXCEPTION 'AI_GOLDEN_IMMUTABLE: a versão do caso não muda; crie a versão seguinte' USING ERRCODE = 'AI044';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RETIRED' THEN
    RAISE EXCEPTION 'AI_GOLDEN_IMMUTABLE: só um caso ACTIVE pode ser aposentado, uma vez' USING ERRCODE = 'AI044';
  END IF;
  RETURN NEW;
END
$f$`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.golden_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        agent_code varchar(64) NOT NULL,
        case_key varchar(80) NOT NULL,
        category varchar(16) NOT NULL,
        input text NOT NULL,
        fixtures jsonb NOT NULL DEFAULT '{}'::jsonb,
        expected jsonb NOT NULL DEFAULT '{}'::jsonb,
        must_not jsonb NOT NULL DEFAULT '[]'::jsonb,
        version integer NOT NULL DEFAULT 1,
        status varchar(10) NOT NULL DEFAULT 'ACTIVE',
        source_candidate_id uuid NULL REFERENCES ai.golden_candidates(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        retired_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        retired_at timestamptz NULL,
        CONSTRAINT golden_cases_scope_chk CHECK ((company_id IS NULL) = (group_id IS NULL)),
        CONSTRAINT golden_cases_agent_chk CHECK (agent_code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
        CONSTRAINT golden_cases_key_chk CHECK (case_key ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
        CONSTRAINT golden_cases_category_chk CHECK (category IN (${CATEGORIES.map((c) => `'${c}'`).join(', ')})),
        CONSTRAINT golden_cases_input_chk CHECK (length(btrim(input)) > 0 AND length(input) <= 4000),
        CONSTRAINT golden_cases_version_chk CHECK (version >= 1),
        CONSTRAINT golden_cases_status_chk CHECK (status IN ('ACTIVE', 'RETIRED')),
        CONSTRAINT golden_cases_json_chk CHECK (jsonb_typeof(fixtures) = 'object' AND jsonb_typeof(expected) = 'object' AND jsonb_typeof(must_not) = 'array'),
        CONSTRAINT golden_cases_retired_chk CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_golden_cases_version_uq ON ai.golden_cases (coalesce(company_id, ${NIL}), agent_code, case_key, version)`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_golden_cases_one_active_uq ON ai.golden_cases (coalesce(company_id, ${NIL}), agent_code, case_key) WHERE status = 'ACTIVE'`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_golden_cases_candidate_uq ON ai.golden_cases (source_candidate_id) WHERE source_candidate_id IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS ai_golden_cases_agent_idx ON ai.golden_cases (company_id, agent_code, status)');

      // Seed do sistema ANTES de ligar o FORCE (padrão das migrations deste projeto).
      for (const c of linhasDoSeed()) {
        await q(
          `INSERT INTO ai.golden_cases (group_id, company_id, agent_code, case_key, category, input, fixtures, expected, must_not, version, status)
           SELECT NULL, NULL, :agentCode, :caseKey, :category, :input, CAST(:fixtures AS jsonb), CAST(:expected AS jsonb), CAST(:mustNot AS jsonb), 1, 'ACTIVE'
            WHERE NOT EXISTS (SELECT 1 FROM ai.golden_cases WHERE company_id IS NULL AND agent_code = :agentCode AND case_key = :caseKey AND version = 1)`,
          { agentCode: c.agentCode, caseKey: c.caseKey, category: c.category, input: c.input, fixtures: JSON.stringify(c.fixtures), expected: JSON.stringify(c.expected), mustNot: JSON.stringify(c.mustNot) }
        );
      }

      await q(FN_GUARD);
      await q('DROP TRIGGER IF EXISTS golden_cases_guard ON ai.golden_cases');
      await q('CREATE TRIGGER golden_cases_guard BEFORE UPDATE OR DELETE ON ai.golden_cases FOR EACH ROW EXECUTE FUNCTION ai.golden_cases_guard()');

      await q('ALTER TABLE ai.golden_cases ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.golden_cases FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.golden_cases');
      await q(`CREATE POLICY tenant_isolation ON ai.golden_cases
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q('DROP POLICY IF EXISTS system_default_read ON ai.golden_cases');
      await q('CREATE POLICY system_default_read ON ai.golden_cases FOR SELECT USING (group_id IS NULL AND company_id IS NULL)');

      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE ON ai.golden_cases TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.golden_cases NO FORCE ROW LEVEL SECURITY');
      const [[{ n }]] = await q('SELECT count(*)::int AS n FROM ai.golden_cases WHERE company_id IS NOT NULL');
      if (n > 0) throw new Error('ai.golden_cases tem casos de empresa (auditoria); apague-os de propósito antes de reverter a migration.');
      await q('ALTER TABLE ai.golden_cases DISABLE TRIGGER golden_cases_guard');
      await q('DROP TABLE IF EXISTS ai.golden_cases');
      await q('DROP FUNCTION IF EXISTS ai.golden_cases_guard()');
    });
  },
};
