# Schema `integration`

Tabelas do schema físico `integration` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `integration.outbox_events` (model `OutboxEvent`)

Transactional Outbox — evento de domínio gravado na mesma transação do dado de negócio, publicado depois no broker.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| aggregate_type | STRING(128) | sim |  |
| aggregate_id | UUID | sim |  |
| event_type | STRING(128) | sim |  |
| event_version | INTEGER | sim |  |
| payload_json | JSONB | sim |  |
| correlation_id | UUID | não |  |
| causation_id | UUID | não |  |
| idempotency_key | STRING(128) | sim | unique |
| classification | STRING(32) | não | ex. TRANSIENT|VALIDATION|CONFLICT |
| occurred_at | DATE | sim |  |
| status | STRING(32) | sim |  |
| retry_count | INTEGER | sim |  |
| next_retry_at | DATE | não |  |
| dead_letter_reason | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `integration.integration_inbox` (model `IntegrationInbox`)

Inbox de deduplicação de consumo de eventos/webhooks externos.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| consumer_name | STRING(128) | sim |  |
| event_id | UUID | sim |  |
| idempotency_key | STRING(128) | sim | unique |
| payload_json | JSONB | não |  |
| status | STRING(32) | sim | RECEIVED|PROCESSING|PROCESSED|FAILED|DEAD |
| retry_count | INTEGER | sim |  |
| next_retry_at | DATE | não |  |
| dead_letter_reason | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `integration.domain_events` (model `DomainEvent`)

Registro append-only do histórico de eventos de domínio já processados internamente (auditoria de fluxo, não é o outbox de transporte).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| aggregate_type | STRING(128) | sim |  |
| aggregate_id | UUID | sim |  |
| event_type | STRING(128) | sim |  |
| payload_json | JSONB | sim |  |
| occurred_at | DATE | sim |  |
| correlation_id | UUID | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
