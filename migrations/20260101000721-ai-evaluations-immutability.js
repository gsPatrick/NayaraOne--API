'use strict';

/**
 * M9-D032 — proteção no banco dos resultados de avaliação da NAY:
 *  - ai.evaluations: máquina QUEUED -> RUNNING -> (PASSED | FAILED | ERROR) (e QUEUED -> ERROR); depois do estado final nada
 *    muda, exceto a homologação humana, que grava homologated_by/at/note UMA vez numa avaliação PASSED (AI041);
 *  - ai.evaluation_items: só entra enquanto a avaliação está QUEUED ou RUNNING e nunca muda nem sai (AI042);
 *  - ai.golden_candidates: decidido (APROVADO ou REJEITADO) não muda mais (AI043).
 */
const FN_EVALUATIONS = `
CREATE OR REPLACE FUNCTION ai.evaluations_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.agent_code IS DISTINCT FROM OLD.agent_code OR NEW.agent_version IS DISTINCT FROM OLD.agent_version
     OR NEW.suite IS DISTINCT FROM OLD.suite OR NEW.triggered_by IS DISTINCT FROM OLD.triggered_by THEN
    RAISE EXCEPTION 'AI_EVALUATION_IMMUTABLE: a identidade da avaliação não muda' USING ERRCODE = 'AI041';
  END IF;
  IF OLD.status IN ('PASSED', 'FAILED', 'ERROR') THEN
    IF OLD.status = 'PASSED' AND OLD.homologated_by IS NULL AND NEW.homologated_by IS NOT NULL AND NEW.status = 'PASSED'
       AND NEW.totals = OLD.totals AND NEW.metrics = OLD.metrics AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at
       AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at AND NEW.error_code IS NOT DISTINCT FROM OLD.error_code
       AND NEW.provider_code IS NOT DISTINCT FROM OLD.provider_code AND NEW.model_code IS NOT DISTINCT FROM OLD.model_code THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AI_EVALUATION_IMMUTABLE: avaliação em estado final não muda' USING ERRCODE = 'AI041';
  END IF;
  IF NEW.homologated_by IS NOT NULL THEN
    RAISE EXCEPTION 'AI_EVALUATION_IMMUTABLE: só avaliação aprovada é homologada' USING ERRCODE = 'AI041';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
       (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'ERROR')) OR (OLD.status = 'RUNNING' AND NEW.status IN ('PASSED', 'FAILED', 'ERROR'))) THEN
    RAISE EXCEPTION 'AI_EVALUATION_IMMUTABLE: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI041';
  END IF;
  RETURN NEW;
END
$f$`;

const FN_ITEMS = `
CREATE OR REPLACE FUNCTION ai.evaluation_items_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE parent_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AI_EVALUATION_IMMUTABLE: item de avaliação não muda nem sai' USING ERRCODE = 'AI042';
  END IF;
  SELECT status INTO parent_status FROM ai.evaluations WHERE id = NEW.evaluation_id;
  IF parent_status IS NULL OR parent_status NOT IN ('QUEUED', 'RUNNING') THEN
    RAISE EXCEPTION 'AI_EVALUATION_IMMUTABLE: a avaliação já terminou; não recebe itens' USING ERRCODE = 'AI042';
  END IF;
  RETURN NEW;
END
$f$`;

const FN_CANDIDATES = `
CREATE OR REPLACE FUNCTION ai.golden_candidates_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.feedback_id IS DISTINCT FROM OLD.feedback_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'AI_GOLDEN_CANDIDATE_DECIDED: a origem do candidato não muda' USING ERRCODE = 'AI043';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'AI_GOLDEN_CANDIDATE_DECIDED: candidato já decidido não muda' USING ERRCODE = 'AI043';
  END IF;
  RETURN NEW;
END
$f$`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(FN_EVALUATIONS);
      await q('DROP TRIGGER IF EXISTS evaluations_guard ON ai.evaluations');
      await q('CREATE TRIGGER evaluations_guard BEFORE UPDATE ON ai.evaluations FOR EACH ROW EXECUTE FUNCTION ai.evaluations_guard()');
      await q(FN_ITEMS);
      await q('DROP TRIGGER IF EXISTS evaluation_items_guard ON ai.evaluation_items');
      await q('CREATE TRIGGER evaluation_items_guard BEFORE INSERT OR UPDATE OR DELETE ON ai.evaluation_items FOR EACH ROW EXECUTE FUNCTION ai.evaluation_items_guard()');
      await q(FN_CANDIDATES);
      await q('DROP TRIGGER IF EXISTS golden_candidates_guard ON ai.golden_candidates');
      await q('CREATE TRIGGER golden_candidates_guard BEFORE UPDATE ON ai.golden_candidates FOR EACH ROW EXECUTE FUNCTION ai.golden_candidates_guard()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS golden_candidates_guard ON ai.golden_candidates');
      await q('DROP TRIGGER IF EXISTS evaluation_items_guard ON ai.evaluation_items');
      await q('DROP TRIGGER IF EXISTS evaluations_guard ON ai.evaluations');
      await q('DROP FUNCTION IF EXISTS ai.golden_candidates_guard()');
      await q('DROP FUNCTION IF EXISTS ai.evaluation_items_guard()');
      await q('DROP FUNCTION IF EXISTS ai.evaluations_guard()');
    });
  },
};
