'use strict';

/**
 * M9-D004 — funções de gatilho de ai.agents e ai.agent_tools.
 * Erros com código AI001 (imutável), AI002 (allowlist/escopo), AI003 (transição) e AI004 (sem homologação); a mensagem começa
 * com o código estável da API (AI_AGENT_IMMUTABLE etc.), que a camada de serviço traduz para HTTP.
 */
const CAMPOS_DE_CONTEUDO = ['group_id', 'company_id', 'code', 'version', 'purpose', 'system_policy', 'model_policy', 'data_scopes',
  'limits', 'criticality', 'config_hash', 'permissions', 'created_by', 'created_at', 'idempotency_key', 'created_from_version'];
const CAMPOS_DE_IDENTIDADE = ['group_id', 'company_id', 'code', 'version', 'created_by', 'created_at', 'idempotency_key', 'created_from_version'];

const mudou = (campos) => campos.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join(' OR ');

async function criarFuncoesAgentes(q) {
  await q(`CREATE OR REPLACE FUNCTION ai.agents_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AI_AGENT_IMMUTABLE: versão de agente não é apagada; aposente-a' USING ERRCODE = 'AI001';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'AI_AGENT_TRANSITION: toda versão nasce em DRAFT' USING ERRCODE = 'AI003';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.status = OLD.status THEN
        IF OLD.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'AI_AGENT_IMMUTABLE: versão % não pode ser editada; crie uma nova versão', OLD.status USING ERRCODE = 'AI001';
        END IF;
        IF ${mudou(CAMPOS_DE_IDENTIDADE)} THEN
          RAISE EXCEPTION 'AI_AGENT_IMMUTABLE: identidade da versão não muda' USING ERRCODE = 'AI001';
        END IF;
        RETURN NEW;
      END IF;
      IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('HOMOLOGATED', 'RETIRED'))
           OR (OLD.status = 'HOMOLOGATED' AND NEW.status IN ('ACTIVE', 'RETIRED'))
           OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
        RAISE EXCEPTION 'AI_AGENT_TRANSITION: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI003';
      END IF;
      IF ${mudou(CAMPOS_DE_CONTEUDO)} THEN
        RAISE EXCEPTION 'AI_AGENT_IMMUTABLE: o conteúdo não muda junto com o estado' USING ERRCODE = 'AI001';
      END IF;
      IF NEW.status IN ('HOMOLOGATED', 'ACTIVE') AND (NEW.homologated_by IS NULL OR NEW.homologated_at IS NULL) THEN
        RAISE EXCEPTION 'AI_AGENT_NOT_HOMOLOGATED: a versão precisa de homologação humana' USING ERRCODE = 'AI004';
      END IF;
      RETURN NEW;
    END
  $fn$`);

  await q(`CREATE OR REPLACE FUNCTION ai.agent_tools_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      pai record;
      alvo uuid;
    BEGIN
      alvo := CASE WHEN TG_OP = 'DELETE' THEN OLD.agent_id ELSE NEW.agent_id END;
      SELECT id, status, group_id, company_id INTO pai FROM ai.agents WHERE id = alvo;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'AI_AGENT_NOT_FOUND: agente da ferramenta não existe' USING ERRCODE = 'AI002';
      END IF;
      IF pai.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'AI_AGENT_IMMUTABLE: a allowlist só muda enquanto a versão é DRAFT' USING ERRCODE = 'AI001';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      IF NEW.group_id IS DISTINCT FROM pai.group_id OR NEW.company_id IS DISTINCT FROM pai.company_id THEN
        RAISE EXCEPTION 'AI_AGENT_TOOL_INVALID: a ferramenta precisa ser da mesma empresa do agente' USING ERRCODE = 'AI002';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
        RAISE EXCEPTION 'AI_AGENT_IMMUTABLE: a ferramenta não troca de agente' USING ERRCODE = 'AI001';
      END IF;
      RETURN NEW;
    END
  $fn$`);

  // AI-003: o agente "possui permissions". São as permissões das tools habilitadas da allowlist, mantidas pelo banco para nunca divergirem.
  await q(`CREATE OR REPLACE FUNCTION ai.agent_tools_sync_permissions() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      alvo uuid;
    BEGIN
      alvo := CASE WHEN TG_OP = 'DELETE' THEN OLD.agent_id ELSE NEW.agent_id END;
      UPDATE ai.agents SET permissions = COALESCE((
        SELECT jsonb_agg(DISTINCT t.permission_code ORDER BY t.permission_code) FROM ai.agent_tools t WHERE t.agent_id = alvo AND t.enabled
      ), '[]'::jsonb) WHERE id = alvo;
      RETURN NULL;
    END
  $fn$`);
}

module.exports = { criarFuncoesAgentes };
