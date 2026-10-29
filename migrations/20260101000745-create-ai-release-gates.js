'use strict';

/**
 * M9-D046 — ai.release_gates: o portão de liberação da NAY para produção. Uma linha por item aprovado por pessoa: RED_TEAM, PENTEST,
 * PRIVACY_REVIEW, DEV_DEPLOY, LAB_VALIDATION, PRODUCTION_APPROVAL (escopo GLOBAL), AGENT_EVALUATION (por agente) e PROVIDER_REVIEW (por
 * provedor). `company_id` NULL = aprovação do grupo, vale para todas as empresas dele. Uma linha por (grupo, empresa, escopo, item):
 * registrar de novo atualiza a mesma linha e a auditoria guarda o antes e o depois. RLS ENABLE + FORCE: a empresa enxerga as suas
 * linhas e as do grupo; GRANT ao nayara_runtime só se o role existir.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.release_gates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        scope_type varchar(10) NOT NULL,
        scope_ref varchar(64) NULL,
        item varchar(24) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'PENDING',
        evidence_ref varchar(500) NULL,
        approved_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        approved_at timestamptz NULL,
        notes text NULL,
        registered_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        idempotency_key varchar(200) NULL,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT release_gates_scope_chk CHECK (scope_type IN ('AGENT', 'PROVIDER', 'GLOBAL')),
        CONSTRAINT release_gates_item_chk CHECK (item IN ('RED_TEAM', 'PENTEST', 'AGENT_EVALUATION', 'PRIVACY_REVIEW', 'PROVIDER_REVIEW', 'PRODUCTION_APPROVAL', 'DEV_DEPLOY', 'LAB_VALIDATION')),
        CONSTRAINT release_gates_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        CONSTRAINT release_gates_item_scope_chk CHECK (
          (item = 'AGENT_EVALUATION' AND scope_type = 'AGENT') OR (item = 'PROVIDER_REVIEW' AND scope_type = 'PROVIDER')
          OR (item NOT IN ('AGENT_EVALUATION', 'PROVIDER_REVIEW') AND scope_type = 'GLOBAL')),
        CONSTRAINT release_gates_ref_chk CHECK ((scope_type = 'GLOBAL' AND scope_ref IS NULL) OR (scope_type <> 'GLOBAL' AND length(btrim(coalesce(scope_ref, ''))) > 0)),
        CONSTRAINT release_gates_approval_chk CHECK ((status = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR (status <> 'APPROVED' AND approved_by IS NULL AND approved_at IS NULL))
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_release_gates_key_uq
        ON ai.release_gates (group_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), item, COALESCE(scope_ref, ''))`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_release_gates_idem_uq ON ai.release_gates (group_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS ai_release_gates_item_idx ON ai.release_gates (item, status)');
      await q('ALTER TABLE ai.release_gates ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.release_gates FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.release_gates');
      await q(`CREATE POLICY tenant_isolation ON ai.release_gates
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND (company_id IS NULL OR company_id = NULLIF(current_setting('app.company_id', true), '')::uuid))`);
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE ON ai.release_gates TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM ai.release_gates', { transaction });
      if (n > 0) throw new Error('ai.release_gates tem aprovações registradas (histórico de liberação); remova-as de propósito antes de reverter a migration.');
      await sequelize.query('DROP TABLE IF EXISTS ai.release_gates', { transaction });
    });
  },
};
