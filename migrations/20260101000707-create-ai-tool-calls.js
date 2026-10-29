'use strict';

/**
 * M9-D006 — ai.tool_calls: uma linha por tentativa de ferramenta da NAY, com argumentos sanitizados (sem PII nem segredo),
 * hash canônico dos argumentos, estado, resultado curto e hash. Idempotência por UNIQUE (company_id, tool_name,
 * idempotency_key) (chave padrão = run_id:seq:args_hash) e ordem por UNIQUE (run_id, seq). Não existe estado EXPIRED: PROPOSED
 * fica até a decisão humana (D007/D019). RLS ENABLE + FORCE por empresa. A máquina de estados e a imutabilidade do estado final
 * são do gatilho (migration 20260101000708). GRANT ao nayara_runtime só se o role existir; sem DELETE.
 */
const STATUS = ['REQUESTED', 'VALIDATED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'PROPOSED', 'CANCELLED_BY_HUMAN'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.tool_calls (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        run_id uuid NOT NULL REFERENCES ai.ai_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        seq integer NOT NULL,
        tool_name varchar(100) NOT NULL,
        tool_version varchar(40) NULL,
        permission_code varchar(100) NULL,
        risk_level varchar(10) NULL,
        args_sanitized jsonb NOT NULL DEFAULT '{}'::jsonb,
        args_hash char(64) NOT NULL,
        idempotency_key varchar(300) NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'REQUESTED',
        blocked_reason varchar(80) NULL,
        result_summary jsonb NULL,
        result_hash char(64) NULL,
        latency_ms integer NULL,
        proposal_id uuid NULL REFERENCES ai.ai_recommendations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at timestamptz NULL,
        content_purged_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by uuid NULL,
        updated_by uuid NULL,
        CONSTRAINT tool_calls_run_seq_uq UNIQUE (run_id, seq),
        CONSTRAINT tool_calls_idempotency_uq UNIQUE (company_id, tool_name, idempotency_key),
        CONSTRAINT tool_calls_seq_chk CHECK (seq >= 1),
        CONSTRAINT tool_calls_name_chk CHECK (length(btrim(tool_name)) > 0),
        CONSTRAINT tool_calls_key_chk CHECK (length(btrim(idempotency_key)) > 0),
        CONSTRAINT tool_calls_status_chk CHECK (status IN (${lista(STATUS)})),
        CONSTRAINT tool_calls_risk_chk CHECK (risk_level IS NULL OR risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT tool_calls_meta_chk CHECK (status IN ('REQUESTED', 'BLOCKED') OR (tool_version IS NOT NULL AND permission_code IS NOT NULL AND risk_level IS NOT NULL)),
        CONSTRAINT tool_calls_blocked_chk CHECK (status <> 'BLOCKED' OR (blocked_reason IS NOT NULL AND length(btrim(blocked_reason)) > 0)),
        CONSTRAINT tool_calls_args_chk CHECK (jsonb_typeof(args_sanitized) = 'object'),
        CONSTRAINT tool_calls_result_chk CHECK (result_summary IS NULL OR jsonb_typeof(result_summary) = 'object'),
        CONSTRAINT tool_calls_args_hash_chk CHECK (args_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT tool_calls_result_hash_chk CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT tool_calls_latency_chk CHECK (latency_ms IS NULL OR latency_ms >= 0)
      )`);
      await q('CREATE INDEX IF NOT EXISTS ai_tool_calls_run_idx ON ai.tool_calls (run_id, seq)');
      await q('CREATE INDEX IF NOT EXISTS ai_tool_calls_company_idx ON ai.tool_calls (company_id, created_at)');
      await q('CREATE INDEX IF NOT EXISTS ai_tool_calls_proposal_idx ON ai.tool_calls (proposal_id) WHERE proposal_id IS NOT NULL');
      await q('ALTER TABLE ai.tool_calls ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.tool_calls FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.tool_calls');
      await q(`CREATE POLICY tenant_isolation ON ai.tool_calls
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE ON ai.tool_calls TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const [[{ n }]] = await q('SELECT count(*)::int AS n FROM ai.tool_calls');
      if (n > 0) throw new Error('ai.tool_calls tem chamadas registradas (registro de auditoria); apague-as de propósito antes de reverter a migration.');
      await q('DROP TABLE IF EXISTS ai.tool_calls');
    });
  },
};
