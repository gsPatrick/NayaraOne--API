'use strict';

/**
 * M9-D401 — funções e gatilhos do schema marketing (parte 2): redação de segredos, validação de actions_result,
 * append-only de publication_results e imutabilidade de versão de automação. Extraído da migration 751 por tamanho.
 */

// Chaves cujo valor nunca é gravado em response_redacted_json.
const SECRET_KEY_RE = "(authorization|cookie|passw(or)?d|secret|api[_-]?key|private[_-]?key|credential|(^|[_-])token$|(access|refresh|id|auth|bearer|session|csrf|xsrf)[_-]?token)";

async function criarFuncoesMarketingParte2(q) {
  await q(`CREATE OR REPLACE FUNCTION marketing.redact_secrets(j jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE AS $fn$
    BEGIN
      IF j IS NULL THEN RETURN NULL; END IF;
      CASE jsonb_typeof(j)
        WHEN 'object' THEN
          RETURN COALESCE((SELECT jsonb_object_agg(k, CASE WHEN k ~* '${SECRET_KEY_RE}' THEN to_jsonb('[REDIGIDO]'::text) ELSE marketing.redact_secrets(v) END)
                             FROM jsonb_each(j) AS t(k, v)), '{}'::jsonb);
        WHEN 'array' THEN
          RETURN COALESCE((SELECT jsonb_agg(marketing.redact_secrets(e) ORDER BY ord) FROM jsonb_array_elements(j) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb);
        WHEN 'string' THEN
          IF (j #>> '{}') ~* '^\\s*(bearer|basic)\\s+\\S+' THEN RETURN to_jsonb('[REDIGIDO]'::text); END IF;
          RETURN j;
        ELSE RETURN j;
      END CASE;
    END
    $fn$`);

  await q(`CREATE OR REPLACE FUNCTION marketing.actions_result_valid(j jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT jsonb_typeof(j) = 'array' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(j) AS t(e)
         WHERE jsonb_typeof(e) <> 'object'
            OR length(btrim(COALESCE(e->>'action_key', ''))) = 0
            OR COALESCE(e->>'status', '') NOT IN ('PENDING','SCHEDULED','OK','SKIPPED','FAILED','UNKNOWN'))
    $fn$`);

  await q(`CREATE OR REPLACE FUNCTION marketing.publication_results_guard() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.response_redacted_json := marketing.redact_secrets(NEW.response_redacted_json);
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'MKT_RESULT_APPEND_ONLY: o resultado de publicação não pode ser alterado.' USING ERRCODE = 'MK002';
    END
    $fn$`);

  await q(`CREATE OR REPLACE FUNCTION marketing.automation_versions_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status <> 'DRAFT' AND (
           NEW.status = 'DRAFT'
        OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
        OR NEW.version_no IS DISTINCT FROM OLD.version_no
        OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
        OR NEW.trigger_config IS DISTINCT FROM OLD.trigger_config
        OR NEW.conditions IS DISTINCT FROM OLD.conditions
        OR NEW.actions IS DISTINCT FROM OLD.actions
        OR NEW.cooldown IS DISTINCT FROM OLD.cooldown
        OR NEW.frequency_cap IS DISTINCT FROM OLD.frequency_cap
        OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
        OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
        OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
        RAISE EXCEPTION 'MKT_AUTOMATION_VERSION_IMMUTABLE: a versão publicada é imutável; crie uma nova versão.' USING ERRCODE = 'MK003';
      END IF;
      RETURN NEW;
    END
    $fn$`);

}

module.exports = { criarFuncoesMarketingParte2 };
