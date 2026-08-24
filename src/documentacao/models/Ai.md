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
