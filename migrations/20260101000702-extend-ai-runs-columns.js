'use strict';

/**
 * M9-D005 — evolui ai.ai_runs (registro de execução da NAY) sem renomear: agente/versão, provider/modelo, caminho de
 * roteamento, tokens, custo em seis casas, aterramento, bloqueio/erro, idempotência, run pai, tempos e as colunas de
 * roteamento (fallback_trail, escalated, cached). Estados e imutabilidade em estado final ficam na migration seguinte.
 *
 * - Runs legados (as NAYs determinísticas) continuam válidos: ganham os padrões RULE / NOT_APPLICABLE / zero tokens e
 *   finished_at = última atualização (estado final exige finished_at).
 * - A tabela tem RLS FORCE: o preenchimento dos legados desliga o FORCE só dentro desta transação.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.ai_runs NO FORCE ROW LEVEL SECURITY');
      await q(`ALTER TABLE ai.ai_runs
        ADD COLUMN IF NOT EXISTS agent_id uuid NULL REFERENCES ai.agents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS agent_version integer NULL,
        ADD COLUMN IF NOT EXISTS purpose varchar(200) NULL,
        ADD COLUMN IF NOT EXISTS provider_code varchar(60) NULL,
        ADD COLUMN IF NOT EXISTS model_code varchar(120) NULL,
        ADD COLUMN IF NOT EXISTS routing_path varchar(16) NOT NULL DEFAULT 'RULE',
        ADD COLUMN IF NOT EXISTS tokens_in integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tokens_out integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cost_currency varchar(3) NOT NULL DEFAULT 'BRL',
        ADD COLUMN IF NOT EXISTS latency_ms integer NULL,
        ADD COLUMN IF NOT EXISTS grounding_status varchar(24) NOT NULL DEFAULT 'NOT_APPLICABLE',
        ADD COLUMN IF NOT EXISTS confidence numeric(4,3) NULL,
        ADD COLUMN IF NOT EXISTS blocked_reason varchar(120) NULL,
        ADD COLUMN IF NOT EXISTS error_code varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS idempotency_key varchar(200) NULL,
        ADD COLUMN IF NOT EXISTS parent_run_id uuid NULL REFERENCES ai.ai_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS finished_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS snapshot_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS request_hash char(64) NULL,
        ADD COLUMN IF NOT EXISTS fallback_trail jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS escalated boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS cached boolean NOT NULL DEFAULT false`);
      await q('ALTER TABLE ai.ai_runs ALTER COLUMN cost_amount TYPE numeric(18,6)');

      // Legados: tudo que já existe é um run COMPLETED, com início na criação e fim na última atualização.
      await q('UPDATE ai.ai_runs SET started_at = created_at, finished_at = updated_at WHERE finished_at IS NULL');

      const checks = [
        ['ai_runs_status_chk', "status IN ('RUNNING','COMPLETED','FAILED','BLOCKED','AWAITING_APPROVAL','CANCELLED')"],
        ['ai_runs_routing_path_chk', "routing_path IN ('RULE','SMALL_MODEL','ADVANCED_MODEL','CACHE')"],
        ['ai_runs_grounding_chk', "grounding_status IN ('GROUNDED','INSUFFICIENT_SOURCES','NOT_APPLICABLE','CONFLICTING_SOURCES')"],
        ['ai_runs_currency_chk', "cost_currency = 'BRL'"],
        ['ai_runs_tokens_chk', 'tokens_in >= 0 AND tokens_out >= 0 AND (latency_ms IS NULL OR latency_ms >= 0)'],
        ['ai_runs_cost_chk', 'cost_amount IS NULL OR cost_amount >= 0'],
        ['ai_runs_confidence_chk', 'confidence IS NULL OR (confidence >= 0 AND confidence <= 1)'],
        ['ai_runs_fallback_trail_chk', "jsonb_typeof(fallback_trail) = 'array'"],
        ['ai_runs_cached_chk', "NOT cached OR routing_path = 'CACHE'"],
        ['ai_runs_blocked_reason_chk', "status <> 'BLOCKED' OR (blocked_reason IS NOT NULL AND length(btrim(blocked_reason)) > 0)"],
        ['ai_runs_finished_chk', "status NOT IN ('COMPLETED','FAILED','BLOCKED','CANCELLED') OR finished_at IS NOT NULL"],
        ['ai_runs_request_hash_chk', "request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'"],
      ];
      for (const [nome, regra] of checks) {
        await q(`ALTER TABLE ai.ai_runs DROP CONSTRAINT IF EXISTS ${nome}`);
        await q(`ALTER TABLE ai.ai_runs ADD CONSTRAINT ${nome} CHECK (${regra})`);
      }
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_runs_idempotency_uq ON ai.ai_runs (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS ai_runs_company_user_idx ON ai.ai_runs (company_id, user_id, created_at DESC)');
      await q('CREATE INDEX IF NOT EXISTS ai_runs_company_agent_idx ON ai.ai_runs (company_id, agent_id, started_at DESC)');
      await q('CREATE INDEX IF NOT EXISTS ai_runs_parent_idx ON ai.ai_runs (parent_run_id) WHERE parent_run_id IS NOT NULL');
      await q('ALTER TABLE ai.ai_runs FORCE ROW LEVEL SECURITY');
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT SELECT, INSERT, UPDATE ON ai.ai_runs TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS ai.ai_runs_idempotency_uq');
      await q('DROP INDEX IF EXISTS ai.ai_runs_company_user_idx');
      await q('DROP INDEX IF EXISTS ai.ai_runs_company_agent_idx');
      await q('DROP INDEX IF EXISTS ai.ai_runs_parent_idx');
      for (const nome of ['status', 'routing_path', 'grounding', 'currency', 'tokens', 'cost', 'confidence', 'fallback_trail', 'cached',
        'blocked_reason', 'finished', 'request_hash']) {
        await q(`ALTER TABLE ai.ai_runs DROP CONSTRAINT IF EXISTS ai_runs_${nome}_chk`);
      }
      for (const c of ['agent_id', 'agent_version', 'purpose', 'provider_code', 'model_code', 'routing_path', 'tokens_in', 'tokens_out',
        'cost_currency', 'latency_ms', 'grounding_status', 'confidence', 'blocked_reason', 'error_code', 'idempotency_key', 'parent_run_id',
        'started_at', 'finished_at', 'snapshot_at', 'request_hash', 'fallback_trail', 'escalated', 'cached']) {
        await q(`ALTER TABLE ai.ai_runs DROP COLUMN IF EXISTS ${c}`);
      }
      await q('ALTER TABLE ai.ai_runs ALTER COLUMN cost_amount TYPE numeric(18,2)');
    });
  },
};
