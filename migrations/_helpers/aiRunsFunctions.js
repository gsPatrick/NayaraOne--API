'use strict';

/**
 * M9-D005 — funções de gatilho de ai.ai_runs e ai.ai_sources.
 * Erros com código AI011 (execução imutável), AI012 (transição de estado não permitida); a mensagem começa com o código
 * estável da API (AI_RUN_IMMUTABLE etc.), que a camada de serviço traduz para HTTP.
 *
 * Estados finais: COMPLETED, FAILED, BLOCKED, CANCELLED. Transições: RUNNING -> COMPLETED | FAILED | BLOCKED |
 * AWAITING_APPROVAL; AWAITING_APPROVAL -> COMPLETED | CANCELLED. Run em estado final não muda e nenhum run é apagado.
 */
const FINAIS = "('COMPLETED','FAILED','BLOCKED','CANCELLED')";
const IDENTIDADE = ['id', 'group_id', 'company_id', 'created_at', 'idempotency_key', 'parent_run_id', 'started_at'];
const mudou = (campos) => campos.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join(' OR ');

async function criarFuncoesRuns(q) {
  await q(`CREATE OR REPLACE FUNCTION ai.ai_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AI_RUN_IMMUTABLE: execução da NAY não é apagada' USING ERRCODE = 'AI011';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IN ${FINAIS} AND NEW.finished_at IS NULL THEN NEW.finished_at := CURRENT_TIMESTAMP; END IF;
        RETURN NEW;
      END IF;
      IF OLD.status IN ${FINAIS} THEN
        RAISE EXCEPTION 'AI_RUN_IMMUTABLE: execução finalizada (%) não pode ser alterada', OLD.status USING ERRCODE = 'AI011';
      END IF;
      IF ${mudou(IDENTIDADE)} THEN
        RAISE EXCEPTION 'AI_RUN_IMMUTABLE: a identidade da execução não muda' USING ERRCODE = 'AI011';
      END IF;
      IF NEW.status <> OLD.status AND NEW.status IN ('RUNNING','COMPLETED','FAILED','BLOCKED','AWAITING_APPROVAL','CANCELLED') THEN
        IF NOT ((OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED','FAILED','BLOCKED','AWAITING_APPROVAL'))
             OR (OLD.status = 'AWAITING_APPROVAL' AND NEW.status IN ('COMPLETED','CANCELLED'))) THEN
          RAISE EXCEPTION 'AI_RUN_TRANSITION: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI012';
        END IF;
      END IF;
      IF NEW.status IN ${FINAIS} AND NEW.finished_at IS NULL THEN NEW.finished_at := CURRENT_TIMESTAMP; END IF;
      RETURN NEW;
    END
  $fn$`);

  await q(`CREATE OR REPLACE FUNCTION ai.ai_sources_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      alvo uuid;
      estado text;
    BEGIN
      alvo := CASE WHEN TG_OP = 'INSERT' THEN NEW.ai_run_id ELSE OLD.ai_run_id END;
      SELECT status INTO estado FROM ai.ai_runs WHERE id = alvo;
      IF estado IN ${FINAIS} THEN
        RAISE EXCEPTION 'AI_RUN_IMMUTABLE: as fontes de uma execução finalizada não mudam' USING ERRCODE = 'AI011';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.ai_run_id IS DISTINCT FROM OLD.ai_run_id THEN
        RAISE EXCEPTION 'AI_RUN_IMMUTABLE: a fonte não troca de execução' USING ERRCODE = 'AI011';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
  $fn$`);
}

module.exports = { criarFuncoesRuns };
