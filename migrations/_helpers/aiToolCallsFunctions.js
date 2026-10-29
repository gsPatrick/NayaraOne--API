'use strict';

/**
 * M9-D006 — funções de gatilho de ai.tool_calls.
 * Erros: AI031 (chamada em estado final não muda; nada é apagado) e AI032 (transição fora da máquina); a mensagem começa com o
 * código estável da API (AI_TOOL_CALL_IMMUTABLE / AI_TOOL_CALL_TRANSITION), que a camada de serviço traduz para HTTP 409.
 *
 * Máquina: REQUESTED -> VALIDATED | BLOCKED; VALIDATED -> EXECUTING | PROPOSED | BLOCKED; EXECUTING -> SUCCEEDED | FAILED | BLOCKED;
 * PROPOSED -> SUCCEEDED | FAILED | CANCELLED_BY_HUMAN | BLOCKED (só pela decisão humana da recomendação, D019). Finais:
 * SUCCEEDED, FAILED, BLOCKED, CANCELLED_BY_HUMAN. Na criação só REQUESTED ou BLOCKED (bloqueio antes de qualquer registro).
 * Única exceção em estado final: o expurgo por retenção (ai.purge_mode = on, M9-D028), que só APAGA args_sanitized e result_summary.
 */
const FINAIS = "('SUCCEEDED','FAILED','BLOCKED','CANCELLED_BY_HUMAN')";
const IDENTIDADE = ['id', 'group_id', 'company_id', 'run_id', 'seq', 'tool_name', 'args_hash', 'idempotency_key', 'created_at', 'started_at'];
const mudou = (campos) => campos.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join(' OR ');
const NEUTRAS = "ARRAY['args_sanitized','result_summary','content_purged_at','updated_at']";

async function criarFuncaoToolCalls(q) {
  await q(`CREATE OR REPLACE FUNCTION ai.tool_calls_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AI_TOOL_CALL_IMMUTABLE: chamada de ferramenta da NAY não é apagada' USING ERRCODE = 'AI031';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('REQUESTED','BLOCKED') THEN
          RAISE EXCEPTION 'AI_TOOL_CALL_TRANSITION: a chamada nasce em REQUESTED (ou BLOCKED), não em %', NEW.status USING ERRCODE = 'AI032';
        END IF;
        IF NEW.status = 'BLOCKED' AND NEW.finished_at IS NULL THEN NEW.finished_at := CURRENT_TIMESTAMP; END IF;
        RETURN NEW;
      END IF;
      IF current_setting('ai.purge_mode', true) = 'on' THEN
        IF NEW.args_sanitized = '{}'::jsonb AND NEW.result_summary IS NULL AND NEW.content_purged_at IS NOT NULL
           AND (to_jsonb(NEW) - ${NEUTRAS}) = (to_jsonb(OLD) - ${NEUTRAS}) THEN
          RETURN NEW;
        END IF;
      END IF;
      IF OLD.status IN ${FINAIS} THEN
        RAISE EXCEPTION 'AI_TOOL_CALL_IMMUTABLE: chamada finalizada (%) não pode ser alterada', OLD.status USING ERRCODE = 'AI031';
      END IF;
      IF ${mudou(IDENTIDADE)} OR NEW.args_sanitized IS DISTINCT FROM OLD.args_sanitized THEN
        RAISE EXCEPTION 'AI_TOOL_CALL_IMMUTABLE: a identidade e os argumentos da chamada não mudam' USING ERRCODE = 'AI031';
      END IF;
      IF NEW.status <> OLD.status THEN
        IF NOT ((OLD.status = 'REQUESTED' AND NEW.status IN ('VALIDATED','BLOCKED'))
             OR (OLD.status = 'VALIDATED' AND NEW.status IN ('EXECUTING','PROPOSED','BLOCKED'))
             OR (OLD.status = 'EXECUTING' AND NEW.status IN ('SUCCEEDED','FAILED','BLOCKED'))
             OR (OLD.status = 'PROPOSED' AND NEW.status IN ('SUCCEEDED','FAILED','CANCELLED_BY_HUMAN','BLOCKED'))) THEN
          RAISE EXCEPTION 'AI_TOOL_CALL_TRANSITION: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI032';
        END IF;
      END IF;
      IF NEW.status IN ${FINAIS} AND NEW.finished_at IS NULL THEN NEW.finished_at := CURRENT_TIMESTAMP; END IF;
      NEW.updated_at := CURRENT_TIMESTAMP;
      RETURN NEW;
    END
  $fn$`);
}

/** Quando o expurgo da retenção (M9-D028) marca o run, o conteúdo das chamadas dele é apagado junto (args_sanitized e result_summary). */
async function criarFuncaoExpurgoDoRun(q) {
  await q(`CREATE OR REPLACE FUNCTION ai.ai_runs_purge_tool_calls() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_setting('ai.purge_mode', true) = 'on' AND to_jsonb(NEW) ->> 'content_purged_at' IS NOT NULL
         AND to_jsonb(OLD) ->> 'content_purged_at' IS NULL THEN
        UPDATE ai.tool_calls SET args_sanitized = '{}'::jsonb, result_summary = NULL, content_purged_at = NEW.content_purged_at
         WHERE run_id = NEW.id AND content_purged_at IS NULL;
      END IF;
      RETURN NEW;
    END
  $fn$`);
}

module.exports = { criarFuncaoToolCalls, criarFuncaoExpurgoDoRun };
