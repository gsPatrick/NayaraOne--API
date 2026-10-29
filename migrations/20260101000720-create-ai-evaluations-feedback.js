'use strict';

/**
 * M9-D032 — avaliação da NAY: ai.evaluations (uma execução da bateria de uma versão de agente), ai.evaluation_items (um caso
 * por linha), ai.feedback (joinha/não gostei de uma pessoa sobre um run) e ai.golden_candidates (fila de casos sugeridos pelo
 * feedback, aprovada por humano). RLS ENABLE + FORCE por empresa. Estado final, homologação e fila são protegidos pelos
 * gatilhos da migration 20260101000721. GRANT ao nayara_runtime só se o role existir; sem DELETE (registro de auditoria).
 * Os campos opcionais da avaliação têm padrão para aceitar a inserção mínima que a M9-D004 usa nos seus testes.
 */
const SUITES = ['GOLDEN', 'ADVERSARIAL', 'ALL'];
const STATUS = ['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR'];
const CATEGORIES = ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'INJECTION', 'COST', 'LATENCY'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');
const TABLES = ['evaluations', 'evaluation_items', 'feedback', 'golden_candidates'];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.evaluations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        agent_code varchar(64) NOT NULL,
        agent_version integer NOT NULL,
        provider_code varchar(60) NULL,
        model_code varchar(120) NULL,
        suite varchar(12) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'QUEUED',
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        totals jsonb NOT NULL DEFAULT '{}'::jsonb,
        metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
        error_code varchar(80) NULL,
        idempotency_key varchar(200) NULL,
        triggered_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        homologated_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        homologated_at timestamptz NULL,
        homologation_note text NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT evaluations_suite_chk CHECK (suite IN (${lista(SUITES)})),
        CONSTRAINT evaluations_status_chk CHECK (status IN (${lista(STATUS)})),
        CONSTRAINT evaluations_version_chk CHECK (agent_version >= 1),
        CONSTRAINT evaluations_totals_chk CHECK (jsonb_typeof(totals) = 'object' AND jsonb_typeof(metrics) = 'object'),
        CONSTRAINT evaluations_homologation_pair_chk CHECK ((homologated_by IS NULL) = (homologated_at IS NULL)),
        CONSTRAINT evaluations_homologation_status_chk CHECK (homologated_by IS NULL OR status = 'PASSED'),
        CONSTRAINT evaluations_homologation_segregation_chk CHECK (homologated_by IS NULL OR triggered_by IS NULL OR homologated_by <> triggered_by),
        CONSTRAINT evaluations_note_chk CHECK (homologation_note IS NULL OR length(homologation_note) <= 1000)
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_evaluations_idempotency_uq ON ai.evaluations (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS ai_evaluations_agent_idx ON ai.evaluations (company_id, agent_code, agent_version, created_at DESC)');
      await q("CREATE INDEX IF NOT EXISTS ai_evaluations_queue_idx ON ai.evaluations (created_at) WHERE status = 'QUEUED'");

      await q(`CREATE TABLE IF NOT EXISTS ai.evaluation_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        evaluation_id uuid NOT NULL REFERENCES ai.evaluations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        case_id varchar(120) NOT NULL,
        category varchar(16) NOT NULL,
        input_hash char(64) NOT NULL,
        expected text NULL,
        actual_summary text NULL,
        passed boolean NOT NULL,
        score numeric(7,4) NOT NULL DEFAULT 0,
        latency_ms integer NULL,
        cost_amount numeric(14,6) NOT NULL DEFAULT 0,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT evaluation_items_case_uq UNIQUE (evaluation_id, case_id),
        CONSTRAINT evaluation_items_category_chk CHECK (category IN (${lista(CATEGORIES)})),
        CONSTRAINT evaluation_items_hash_chk CHECK (input_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT evaluation_items_score_chk CHECK (score >= 0 AND score <= 1),
        CONSTRAINT evaluation_items_cost_chk CHECK (cost_amount >= 0),
        CONSTRAINT evaluation_items_latency_chk CHECK (latency_ms IS NULL OR latency_ms >= 0),
        CONSTRAINT evaluation_items_details_chk CHECK (jsonb_typeof(details) = 'object')
      )`);

      await q(`CREATE TABLE IF NOT EXISTS ai.feedback (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        run_id uuid NOT NULL REFERENCES ai.ai_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        rating varchar(4) NOT NULL,
        category varchar(40) NULL,
        comment varchar(500) NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT feedback_run_user_uq UNIQUE (run_id, user_id),
        CONSTRAINT feedback_rating_chk CHECK (rating IN ('UP', 'DOWN'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS ai_feedback_company_idx ON ai.feedback (company_id, created_at DESC)');

      await q(`CREATE TABLE IF NOT EXISTS ai.golden_candidates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        feedback_id uuid NOT NULL REFERENCES ai.feedback(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        run_id uuid NOT NULL REFERENCES ai.ai_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        agent_code varchar(64) NULL,
        category varchar(40) NULL,
        comment varchar(500) NULL,
        status varchar(10) NOT NULL DEFAULT 'PENDING',
        decided_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        decided_at timestamptz NULL,
        decision_note varchar(500) NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT golden_candidates_feedback_uq UNIQUE (feedback_id),
        CONSTRAINT golden_candidates_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        CONSTRAINT golden_candidates_decision_chk CHECK ((status = 'PENDING') = (decided_by IS NULL AND decided_at IS NULL))
      )`);

      for (const t of TABLES) {
        await q(`ALTER TABLE ai.${t} ENABLE ROW LEVEL SECURITY`);
        await q(`ALTER TABLE ai.${t} FORCE ROW LEVEL SECURITY`);
        await q(`DROP POLICY IF EXISTS tenant_isolation ON ai.${t}`);
        await q(`CREATE POLICY tenant_isolation ON ai.${t}
          USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
                 AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      }
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE ON ai.evaluations, ai.evaluation_items, ai.feedback, ai.golden_candidates TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const [[{ n }]] = await q('SELECT (SELECT count(*) FROM ai.evaluations) + (SELECT count(*) FROM ai.feedback) AS n');
      if (Number(n) > 0) throw new Error('ai.evaluations/ai.feedback têm registros (auditoria); apague-os de propósito antes de reverter a migration.');
      for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS ai.${t}`);
    });
  },
};
