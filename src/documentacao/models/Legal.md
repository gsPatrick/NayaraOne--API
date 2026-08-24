# Schema `legal`

Tabelas do schema físico `legal` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `legal.contracts` (model `Contract`)

Contrato (venda, locação, prestação de serviço) — cabeçalho.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | não | FK real_estate.properties |
| opportunity_id | UUID | não | FK crm.opportunities |
| contract_type | STRING(32) | sim | SALE|LEASE|SERVICE |
| contract_number | STRING(64) | não |  |
| status | STRING(32) | sim |  |
| total_value | DECIMAL(18, 2) | não |  |
| starts_at | DATE | não |  |
| ends_at | DATE | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.contract_parties` (model `ContractParty`)

Parte envolvida em um contrato (locador, locatário, fiador, comprador, vendedor).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| contract_id | UUID | sim | FK legal.contracts |
| person_id | UUID | sim | FK people.persons |
| party_role | STRING(32) | sim | LANDLORD|TENANT|GUARANTOR|BUYER|SELLER |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.contract_versions` (model `ContractVersion`)

Versão imutável de um contrato (aditivos geram nova versão, nunca edição da anterior).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| contract_id | UUID | sim | FK legal.contracts |
| version_number | INTEGER | sim |  |
| document_file_id | UUID | não | FK people.files |
| content_hash | STRING(64) | não |  |
| effective_from | DATE | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.signatures` (model `Signature`)

Assinatura eletrônica de uma parte sobre uma versão de contrato.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| contract_version_id | UUID | sim | FK legal.contract_versions |
| person_id | UUID | sim | FK people.persons |
| signed_at | DATE | não |  |
| status | STRING(32) | sim |  |
| external_signature_id | STRING(128) | não | ID no provedor de assinatura eletrônica |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.legal_cases` (model `LegalCase`)

Processo/caso jurídico (contencioso ou consultivo) vinculado a contrato/imóvel/pessoa.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| contract_id | UUID | não | FK legal.contracts |
| property_id | UUID | não | FK real_estate.properties |
| responsible_user_id | UUID | não | FK core.users |
| case_number | STRING(64) | não |  |
| case_type | STRING(32) | sim | LITIGATION|CONSULTATIVE|COLLECTION |
| status | STRING(32) | sim |  |
| summary | TEXT | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.legal_deadlines` (model `LegalDeadline`)

Prazo processual/contratual crítico vinculado a um caso jurídico.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| legal_case_id | UUID | sim | FK legal.legal_cases |
| description | STRING(255) | sim |  |
| due_at | DATE | sim |  |
| status | STRING(32) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.inspections` (model `Inspection`)

Vistoria de um imóvel (entrada, saída, periódica) vinculada a um contrato de locação.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | sim | FK real_estate.properties |
| contract_id | UUID | não | FK legal.contracts |
| inspector_user_id | UUID | não | FK core.users |
| inspection_type | STRING(32) | sim | CHECK_IN|CHECK_OUT|PERIODIC |
| scheduled_at | DATE | não |  |
| completed_at | DATE | não |  |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.inspection_items` (model `InspectionItem`)

Item/ambiente avaliado dentro de uma vistoria, com condição registrada.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| inspection_id | UUID | sim | FK legal.inspections |
| item_name | STRING(255) | sim |  |
| condition | STRING(32) | não | GOOD|REGULAR|DAMAGED |
| notes | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `legal.insurance_cases` (model `InsuranceCase`)

Sinistro/caso de seguro vinculado a um imóvel ou contrato.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | não | FK real_estate.properties |
| contract_id | UUID | não | FK legal.contracts |
| policy_number | STRING(64) | não |  |
| case_type | STRING(32) | não |  |
| status | STRING(32) | sim |  |
| claim_amount | DECIMAL(18, 2) | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
