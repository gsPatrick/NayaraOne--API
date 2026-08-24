# Schema `construction`

Tabelas do schema físico `construction` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `construction.projects` (model `Project`)

Obra/empreendimento de construção civil.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | não | FK real_estate.properties |
| name | STRING(255) | sim |  |
| responsible_user_id | UUID | não | FK core.users |
| budget_amount | DECIMAL(18, 2) | não |  |
| starts_at | DATE | não |  |
| ends_at_planned | DATE | não |  |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `construction.project_stages` (model `ProjectStage`)

Etapa/marco físico de uma obra, com medição associada (RDO).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| project_id | UUID | sim | FK construction.projects |
| name | STRING(255) | sim |  |
| sequence | INTEGER | sim |  |
| planned_pct | DECIMAL(9, 6) | não |  |
| measured_pct | DECIMAL(9, 6) | não |  |
| status | STRING(32) | sim |  |
| starts_at | DATE | não |  |
| ends_at | DATE | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `construction.maintenance_cases` (model `MaintenanceCase`)

Chamado de manutenção/pós-obra vinculado a um imóvel/projeto, dentro do prazo de garantia.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | sim | FK real_estate.properties |
| project_id | UUID | não | FK construction.projects |
| opened_by_person_id | UUID | não | FK people.persons |
| responsible_user_id | UUID | não | FK core.users |
| description | TEXT | sim |  |
| status | STRING(32) | sim |  |
| warranty_deadline_at | DATE | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
