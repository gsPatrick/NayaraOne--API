# Schema `ai`

Tabelas do schema físico `ai` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `ai.ai_runs` (model `AiRun`)

Execução de um agente/tool da NAY — registro de auditoria de orquestração de IA.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| user_id | UUID | não | Usuário cujo escopo a NAY herdou — FK core.users |
| agent_name | STRING(64) | sim | ex. NAY_ATENDIMENTO|NAY_COMERCIAL|NAY_FINANCEIRA |
| input_summary | TEXT | não |  |
| tool_calls_json | JSONB | não |  |
| output_summary | TEXT | não |  |
| status | STRING(32) | sim |  |
| cost_amount | DECIMAL(18, 2) | não |  |
| correlation_id | UUID | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `ai.ai_sources` (model `AiSource`)

Fonte documental/interna citada por uma resposta da NAY (rastreabilidade antialucinação).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| ai_run_id | UUID | sim | FK ai.ai_runs |
| source_type | STRING(64) | sim | ex. DB_RECORD|DOCUMENT|KNOWLEDGE_ENTRY |
| source_ref | STRING(255) | não |  |
| excerpt | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `ai.knowledge_entries` (model `KnowledgeEntry`)

Fato estruturado e versionado da memória empresarial da NAY (não é cópia integral de conversa).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| subject_type | STRING(64) | sim |  |
| subject_id | UUID | não |  |
| fact_key | STRING(128) | sim |  |
| fact_value_json | JSONB | sim |  |
| origin | STRING(64) | não |  |
| classification | STRING(16) | sim |  |
| valid_from | DATE | não |  |
| valid_until | DATE | não |  |
| is_active | BOOLEAN | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `ai.ai_recommendations` (model `AiRecommendation`)

Recomendação/proposta gerada por um agente da NAY, sujeita a aprovação humana quando crítica.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| ai_run_id | UUID | não | FK ai.ai_runs |
| related_entity_type | STRING(64) | sim |  |
| related_entity_id | UUID | sim |  |
| recommendation_type | STRING(64) | sim |  |
| payload_json | JSONB | não |  |
| risk_level | STRING(16) | sim |  |
| status | STRING(32) | sim | PENDING|ACCEPTED|REJECTED|AUTO_APPLIED |
| decided_by_user_id | UUID | não | FK core.users |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `ai.agents` (model `AiAgent`) — M9-D004

Uma linha por VERSÃO de agente da NAY (`code` + `version`). `company_id`/`group_id` nulos = padrão do sistema (os oito agentes do livro, em DRAFT e desabilitados), legível por toda empresa e nunca alterado pela aplicação.

- Multiempresa (RLS FORCE): sim, com leitura do padrão do sistema; escrita só da própria empresa
- Ciclo: DRAFT, HOMOLOGATED, ACTIVE, RETIRED; fora de DRAFT a linha é imutável (gatilho `ai.agents_guard`); uma ACTIVE por (empresa, code)
- Unicidade (empresa, code, version) e uma ACTIVE por (empresa, code) por índices que tratam o NULL do sistema como valor

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id / company_id | UUID | não | NULL nos dois = padrão do sistema |
| code | STRING(60) | sim | ex. NAY_COMERCIAL |
| version | INTEGER | sim | 1, 2, 3 por code e empresa |
| status | STRING(12) | sim | DRAFT, HOMOLOGATED, ACTIVE, RETIRED |
| purpose | TEXT | sim | finalidade (AI-003); CHECK recusa vazio |
| system_policy | TEXT | sim | política do agente (só ai:admin lê/escreve) |
| model_policy | JSONB | sim | capacidade exigida, classe de modelo, maxOutputTokens, cacheableTaskTypes |
| permissions | JSONB | sim | permissões das tools habilitadas, mantidas por gatilho |
| data_scopes | JSONB | sim | lista de escopos de dados |
| limits | JSONB | sim | max_tool_calls_por_run, max_runs_por_minuto_usuario, timeout_ms, max_tokens_run (vencem o parâmetro `ia.agente.*`) |
| criticality | STRING(12) | sim | CRITICAL ou NON_CRITICAL |
| enabled | BOOLEAN | sim | true só enquanto ACTIVE |
| config_hash | CHAR(64) | sim | sha256 do conteúdo e da allowlist |
| homologated_by/at, homologation_note | UUID/TIMESTAMPTZ/TEXT | não | homologação humana (ai:evaluate) |
| activated_by/at, retired_by/at | UUID/TIMESTAMPTZ | não | ativação e aposentadoria |
| idempotency_key, created_from_version | STRING(200)/INTEGER | não | repetição segura e origem da cópia |

## `ai.agent_tools` (model `AiAgentTool`) — M9-D004

Allowlist de tools de uma versão (`UNIQUE (agent_id, tool_name)`); só muda com o agente em DRAFT. `risk_level` HIGH ou CRITICAL obriga `requires_human_approval = true` (CHECK). `permission_code` vem da definição da tool, nunca do agente nem do modelo.
