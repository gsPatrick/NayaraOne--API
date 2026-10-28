'use strict';

/**
 * M9-D008 — função de gatilho de ai.knowledge_entries. Erros: AI021 (imutável), AI022 (transição), AI023 (autor homologando o
 * próprio conhecimento), AI024 (homologação sem homologador). A mensagem começa com o código estável da API.
 *
 * DRAFT é editável (e apagável). DRAFT -> HOMOLOGATED exige homologador diferente do autor (created_by). HOMOLOGATED ->
 * SUPERSEDED | REVOKED muda só o estado e os campos da própria transição. SUPERSEDED e REVOKED não mudam mais (REVOKED não reativa).
 */
const IDENTIDADE = ['group_id', 'company_id', 'fact_key', 'version', 'created_by', 'created_at'];
const mudou = (campos) => campos.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join(' OR ');
const CAMPOS_DA_TRANSICAO = "'status','revoked_by','revoked_at','revoke_reason','is_active','updated_at','updated_by','lock_version'";

async function criarFuncaoConhecimento(q) {
  await q(`CREATE OR REPLACE FUNCTION ai.knowledge_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'AI_KNOWLEDGE_IMMUTABLE: conhecimento % não é apagado; revogue ou crie nova versão', OLD.status USING ERRCODE = 'AI021';
        END IF;
        RETURN OLD;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'AI_KNOWLEDGE_TRANSITION: todo conhecimento nasce em DRAFT' USING ERRCODE = 'AI022';
        END IF;
        RETURN NEW;
      END IF;
      IF ${mudou(IDENTIDADE)} THEN
        RAISE EXCEPTION 'AI_KNOWLEDGE_IMMUTABLE: a identidade do conhecimento não muda' USING ERRCODE = 'AI021';
      END IF;
      IF NEW.status = OLD.status THEN
        IF OLD.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'AI_KNOWLEDGE_IMMUTABLE: conhecimento % não pode ser editado; crie uma nova versão', OLD.status USING ERRCODE = 'AI021';
        END IF;
        RETURN NEW;
      END IF;
      IF NOT ((OLD.status = 'DRAFT' AND NEW.status = 'HOMOLOGATED')
           OR (OLD.status = 'HOMOLOGATED' AND NEW.status IN ('SUPERSEDED', 'REVOKED'))) THEN
        RAISE EXCEPTION 'AI_KNOWLEDGE_TRANSITION: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI022';
      END IF;
      IF NEW.status = 'HOMOLOGATED' THEN
        IF NEW.homologated_by IS NULL OR NEW.homologated_at IS NULL THEN
          RAISE EXCEPTION 'AI_KNOWLEDGE_NOT_HOMOLOGATED: a homologação precisa de pessoa e data' USING ERRCODE = 'AI024';
        END IF;
        IF OLD.created_by IS NOT NULL AND NEW.homologated_by = OLD.created_by THEN
          RAISE EXCEPTION 'AI_KNOWLEDGE_SELF_HOMOLOGATION: quem escreveu não pode homologar' USING ERRCODE = 'AI023';
        END IF;
      ELSIF (to_jsonb(NEW) - ARRAY[${CAMPOS_DA_TRANSICAO}]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[${CAMPOS_DA_TRANSICAO}]) THEN
        RAISE EXCEPTION 'AI_KNOWLEDGE_IMMUTABLE: o conteúdo não muda junto com o estado' USING ERRCODE = 'AI021';
      END IF;
      RETURN NEW;
    END
  $fn$`);
}

module.exports = { criarFuncaoConhecimento };
