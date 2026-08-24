# Schema `inventory`

Tabelas do schema físico `inventory` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `inventory.inventory_items` (model `InventoryItem`)

Item de estoque (material, insumo, ferramenta) mantido em depósito.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| sku | STRING(64) | não |  |
| name | STRING(255) | sim |  |
| unit_of_measure | STRING(16) | não |  |
| quantity_on_hand | DECIMAL(9, 6) | sim |  |
| minimum_quantity | DECIMAL(9, 6) | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `inventory.inventory_movements` (model `InventoryMovement`)

Movimentação append-only de entrada/saída de um item de estoque.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| inventory_item_id | UUID | sim | FK inventory.inventory_items |
| project_id | UUID | não | FK construction.projects |
| movement_type | STRING(16) | sim | IN|OUT|TRANSFER |
| quantity | DECIMAL(9, 6) | sim |  |
| moved_at | DATE | sim |  |
| moved_by_user_id | UUID | não | FK core.users |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `inventory.assets` (model `Asset`)

Bem patrimonial (ferramenta, equipamento, veículo) rastreável por QR Code.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| asset_tag | STRING(64) | não | Código impresso no QR Code — unique |
| name | STRING(255) | sim |  |
| assigned_to_user_id | UUID | não | FK core.users |
| project_id | UUID | não | FK construction.projects |
| acquisition_value | DECIMAL(18, 2) | não |  |
| acquired_at | DATE | não |  |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
