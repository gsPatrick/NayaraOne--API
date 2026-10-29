'use strict';

/**
 * M9-D007 — ai.ai_recommendations: recomendação, decisão humana e resultado. Colunas novas (agente, título, justificativa,
 * confiança, ação proposta, decisão, motivo, resultado, destinatário e chave de duplicidade), risco CRITICAL, estados
 * PENDING -> ACCEPTED -> (EXECUTED | EXECUTION_FAILED), PENDING -> REJECTED | STALE e o EXPIRED que a NAY de Estoque já usa.
 * O gatilho recusa transição fora da máquina e mudança da decisão tomada (AI021 -> 409 AI_RECOMMENDATION_STATE); a decisão é
 * sempre de uma pessoa (decided_by_user_id obrigatório quando há decisão). Duas pendentes com a mesma dedup_key não coexistem.
 * Os valores do gatilho são os da inventoryNay: ela grava só status/decided_by_user_id e o gatilho preenche decisão e data.
 */
const STATUS = ['PENDING', 'ACCEPTED', 'REJECTED', 'STALE', 'EXECUTED', 'EXECUTION_FAILED', 'EXPIRED'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

const GUARD = `
CREATE OR REPLACE FUNCTION ai.ai_recommendations_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('ACCEPTED','REJECTED','STALE','EXPIRED'))
         OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('EXECUTED','EXECUTION_FAILED'))) THEN
      RAISE EXCEPTION 'AI_RECOMMENDATION_STATE: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI021';
    END IF;
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'AI_RECOMMENDATION_STATE: a decisão já tomada não muda' USING ERRCODE = 'AI021';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status IN ('ACCEPTED','REJECTED') THEN
    NEW.decision := COALESCE(NEW.decision, NEW.status);
    IF NEW.decision <> NEW.status THEN
      RAISE EXCEPTION 'AI_RECOMMENDATION_STATE: a decisão % não combina com o estado %', NEW.decision, NEW.status USING ERRCODE = 'AI021';
    END IF;
    NEW.decided_at := COALESCE(NEW.decided_at, CURRENT_TIMESTAMP);
  END IF;
  IF NEW.status IN ('EXECUTED','EXECUTION_FAILED') THEN
    NEW.outcome := NEW.status;
    NEW.outcome_at := COALESCE(NEW.outcome_at, CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END
$f$`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.ai_recommendations NO FORCE ROW LEVEL SECURITY');
      await q(`ALTER TABLE ai.ai_recommendations
        ADD COLUMN IF NOT EXISTS agent_code varchar(64) NULL,
        ADD COLUMN IF NOT EXISTS title varchar(200) NULL,
        ADD COLUMN IF NOT EXISTS rationale text NULL,
        ADD COLUMN IF NOT EXISTS confidence numeric(4,3) NULL,
        ADD COLUMN IF NOT EXISTS proposed_action jsonb NULL,
        ADD COLUMN IF NOT EXISTS decision varchar(12) NULL,
        ADD COLUMN IF NOT EXISTS decision_reason text NULL,
        ADD COLUMN IF NOT EXISTS decided_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS outcome varchar(20) NULL,
        ADD COLUMN IF NOT EXISTS outcome_detail text NULL,
        ADD COLUMN IF NOT EXISTS outcome_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS target_user_id uuid NULL REFERENCES core.users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
        ADD COLUMN IF NOT EXISTS dedup_key char(64) NULL`);
      // Legado (NAY de Estoque): a decisão e a data já registradas viram colunas próprias quando há uma pessoa decisora.
      await q(`UPDATE ai.ai_recommendations SET decision = status, decided_at = updated_at
                WHERE status IN ('ACCEPTED','REJECTED') AND decided_by_user_id IS NOT NULL AND decision IS NULL`);
      const checks = [
        ['status', `status IN (${lista(STATUS)})`],
        ['risk', "risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')"],
        ['decision', "decision IS NULL OR decision IN ('ACCEPTED','REJECTED')"],
        ['outcome', "outcome IS NULL OR outcome IN ('EXECUTED','EXECUTION_FAILED','NOT_APPLICABLE')"],
        ['decision_human', 'decision IS NULL OR decided_by_user_id IS NOT NULL'],
        ['decision_status', `(decision IS NULL OR status IN ('ACCEPTED','REJECTED','EXECUTED','EXECUTION_FAILED'))
          AND (status <> 'REJECTED' OR decision IS NULL OR decision = 'REJECTED')
          AND (status NOT IN ('ACCEPTED','EXECUTED','EXECUTION_FAILED') OR decision IS NULL OR decision = 'ACCEPTED')`],
        ['outcome_status', `(status <> 'EXECUTED' OR outcome = 'EXECUTED') AND (status <> 'EXECUTION_FAILED' OR outcome = 'EXECUTION_FAILED')
          AND (outcome IS NULL OR outcome NOT IN ('EXECUTED','EXECUTION_FAILED') OR outcome = status)`],
        ['confidence', 'confidence IS NULL OR (confidence >= 0 AND confidence <= 1)'],
        ['action', "proposed_action IS NULL OR jsonb_typeof(proposed_action) = 'object'"],
        ['dedup', "dedup_key IS NULL OR dedup_key ~ '^[0-9a-f]{64}$'"],
      ];
      for (const [nome, regra] of checks) {
        await q(`ALTER TABLE ai.ai_recommendations DROP CONSTRAINT IF EXISTS ai_recommendations_${nome}_chk`);
        await q(`ALTER TABLE ai.ai_recommendations ADD CONSTRAINT ai_recommendations_${nome}_chk CHECK (${regra})`);
      }
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_recommendations_dedup_uq ON ai.ai_recommendations (company_id, dedup_key)
        WHERE dedup_key IS NOT NULL AND status = 'PENDING' AND deleted_at IS NULL`);
      await q('CREATE INDEX IF NOT EXISTS ai_recommendations_target_idx ON ai.ai_recommendations (target_user_id) WHERE target_user_id IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS ai_recommendations_company_status_idx ON ai.ai_recommendations (company_id, status, created_at DESC)');
      await q(GUARD);
      await q('DROP TRIGGER IF EXISTS ai_recommendations_guard ON ai.ai_recommendations');
      await q('CREATE TRIGGER ai_recommendations_guard BEFORE UPDATE ON ai.ai_recommendations FOR EACH ROW EXECUTE FUNCTION ai.ai_recommendations_guard()');
      await q('ALTER TABLE ai.ai_recommendations FORCE ROW LEVEL SECURITY');
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT SELECT, INSERT, UPDATE ON ai.ai_recommendations TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS ai_recommendations_guard ON ai.ai_recommendations');
      await q('DROP FUNCTION IF EXISTS ai.ai_recommendations_guard()');
      await q('DROP INDEX IF EXISTS ai.ai_recommendations_dedup_uq');
      await q('DROP INDEX IF EXISTS ai.ai_recommendations_company_status_idx');
      for (const n of ['status', 'risk', 'decision', 'outcome', 'decision_human', 'decision_status', 'outcome_status', 'confidence', 'action', 'dedup']) {
        await q(`ALTER TABLE ai.ai_recommendations DROP CONSTRAINT IF EXISTS ai_recommendations_${n}_chk`);
      }
      for (const c of ['agent_code', 'title', 'rationale', 'confidence', 'proposed_action', 'decision', 'decision_reason', 'decided_at', 'outcome',
        'outcome_detail', 'outcome_at', 'dedup_key']) {
        await q(`ALTER TABLE ai.ai_recommendations DROP COLUMN IF EXISTS ${c}`);
      }
    });
  },
};
