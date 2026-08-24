# Schema `real_estate`

Tabelas do schema físico `real_estate` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `real_estate.properties` (model `Property`)

Imóvel administrado/comercializado pela imobiliária.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| title | STRING(255) | sim |  |
| property_type | STRING(32) | sim | RESIDENTIAL|COMMERCIAL|LAND|RURAL |
| address_line | STRING(255) | não |  |
| city | STRING(128) | não |  |
| state | STRING(2) | não |  |
| zip_code | STRING(16) | não |  |
| area_total_m2 | DECIMAL(9, 6) | não |  |
| status | STRING(32) | sim | AVAILABLE|RESERVED|RENTED|SOLD|INACTIVE |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `real_estate.property_owners` (model `PropertyOwner`)

Vínculo de titularidade/proprietário de um imóvel, com percentual de participação.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | sim | FK real_estate.properties |
| person_id | UUID | sim | FK people.persons |
| ownership_pct | DECIMAL(9, 6) | sim |  |
| starts_at | DATE | não |  |
| ends_at | DATE | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `real_estate.property_offers` (model `PropertyOffer`)

Oferta comercial vigente de um imóvel (venda e/ou locação).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | sim | FK real_estate.properties |
| offer_type | STRING(16) | sim | SALE|RENT |
| price_amount | DECIMAL(18, 2) | sim |  |
| status | STRING(32) | sim |  |
| starts_at | DATE | não |  |
| ends_at | DATE | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `real_estate.property_price_history` (model `PropertyPriceHistory`)

Histórico append-only de alterações de preço de uma oferta/imóvel.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | sim | FK real_estate.properties |
| property_offer_id | UUID | não | FK real_estate.property_offers |
| previous_price | DECIMAL(18, 2) | não |  |
| new_price | DECIMAL(18, 2) | sim |  |
| changed_at | DATE | sim |  |
| changed_by_user_id | UUID | não | FK core.users |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
