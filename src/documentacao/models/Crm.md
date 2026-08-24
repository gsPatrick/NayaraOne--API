# Schema `crm`

Tabelas do schema físico `crm` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `crm.opportunities` (model `Opportunity`)

Oportunidade comercial (funil de vendas/locação) associada a um cliente e opcionalmente a um imóvel.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| person_id | UUID | sim | Cliente/lead — FK people.persons |
| property_id | UUID | não | FK real_estate.properties |
| owner_user_id | UUID | não | Corretor/responsável — FK core.users |
| stage | STRING(32) | sim |  |
| temperature | STRING(16) | não | COLD|WARM|HOT |
| expected_value | DECIMAL(18, 2) | não |  |
| closed_at | DATE | não |  |
| lost_reason | TEXT | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `crm.property_radars` (model `PropertyRadar`)

Perfil de busca (radar) de um cliente para receber imóveis compatíveis automaticamente.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| person_id | UUID | sim | FK people.persons |
| opportunity_id | UUID | não | FK crm.opportunities |
| criteria_json | JSONB | sim | Critérios de matching (tipo, bairro, faixa de preço etc.) |
| status | STRING(32) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `crm.visits` (model `Visit`)

Visita agendada/realizada a um imóvel por um cliente.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | sim | FK real_estate.properties |
| opportunity_id | UUID | não | FK crm.opportunities |
| person_id | UUID | sim | FK people.persons |
| agent_user_id | UUID | não | FK core.users |
| scheduled_at | DATE | sim |  |
| status | STRING(32) | sim |  |
| feedback | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `crm.messages` (model `Message`)

Mensagem de atendimento omnichannel (WhatsApp etc.), vinculada a uma pessoa/oportunidade.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| person_id | UUID | não | FK people.persons |
| opportunity_id | UUID | não | FK crm.opportunities |
| channel | STRING(32) | sim |  |
| direction | STRING(16) | sim | INBOUND|OUTBOUND |
| author_type | STRING(16) | sim | CLIENT|NAY|EMPLOYEE |
| author_user_id | UUID | não | FK core.users |
| body | TEXT | não |  |
| status | STRING(32) | sim |  |
| external_message_id | STRING(128) | não | ID do provedor — usado para deduplicação de webhook — unique |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
