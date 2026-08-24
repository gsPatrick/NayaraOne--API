# Schema `finance`

Tabelas do schema físico `finance` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `finance.bank_accounts` (model `BankAccount`)

Conta bancária/financeira da empresa ou de um proprietário — dados sensíveis, mascarados na aplicação.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| owner_person_id | UUID | não | Preenchido quando a conta pertence a um proprietário/terceiro — FK people.persons |
| bank_code | STRING(16) | não |  |
| agency | STRING(16) | não |  |
| account_number | STRING(32) | não |  |
| pix_key | STRING(255) | não |  |
| status | STRING(32) | sim | Conta nova entra em período de resfriamento antes de elegível a pagamento |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.cost_centers` (model `CostCenter`)

Centro de custo para classificação de lançamentos financeiros.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| code | STRING(32) | sim |  |
| name | STRING(255) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.result_centers` (model `ResultCenter`)

Centro de resultado para apuração gerencial.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| code | STRING(32) | sim |  |
| name | STRING(255) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.financial_entries` (model `FinancialEntry`)

Ledger financeiro append-only — lançamento realizado (correção sempre por estorno/compensação, nunca UPDATE/DELETE destrutivo).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| bank_account_id | UUID | não | FK finance.bank_accounts |
| cost_center_id | UUID | não | FK finance.cost_centers |
| result_center_id | UUID | não | FK finance.result_centers |
| contract_id | UUID | não | FK legal.contracts |
| entry_type | STRING(16) | sim | DEBIT|CREDIT |
| nature | STRING(32) | sim | PAYABLE|RECEIVABLE|TRANSFER|ADJUSTMENT |
| amount | DECIMAL(18, 2) | sim |  |
| due_at | DATE | não |  |
| settled_at | DATE | não |  |
| status | STRING(32) | sim |  |
| idempotency_key | STRING(128) | não | unique |
| reversal_of_entry_id | UUID | não | Auto-referência: aponta para o lançamento estornado |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.bank_transactions` (model `BankTransaction`)

Transação bruta importada do extrato bancário (OFX/API), insumo da conciliação.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| bank_account_id | UUID | sim | FK finance.bank_accounts |
| external_transaction_id | STRING(128) | não | unique |
| amount | DECIMAL(18, 2) | sim |  |
| transaction_date | DATE | sim |  |
| description | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.reconciliations` (model `Reconciliation`)

Vínculo de conciliação entre um lançamento do ledger e uma transação bancária.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| financial_entry_id | UUID | sim | FK finance.financial_entries |
| bank_transaction_id | UUID | sim | FK finance.bank_transactions |
| matched_at | DATE | sim |  |
| matched_by_user_id | UUID | não | FK core.users |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.approval_requests` (model `ApprovalRequest`)

Solicitação de aprovação (maker-checker) para operações financeiras/críticas.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| related_entity_type | STRING(64) | sim |  |
| related_entity_id | UUID | sim |  |
| requested_by_user_id | UUID | sim | FK core.users |
| status | STRING(32) | sim |  |
| risk_level | STRING(16) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.approval_steps` (model `ApprovalStep`)

Etapa individual de decisão dentro de uma solicitação de aprovação (segregação de função: quem cria não aprova).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| approval_request_id | UUID | sim | FK finance.approval_requests |
| approver_user_id | UUID | sim | FK core.users |
| step_order | INTEGER | sim |  |
| decision | STRING(16) | não | APPROVED|REJECTED |
| decided_at | DATE | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.commissions` (model `Commission`)

Comissão calculada para um corretor/colaborador sobre uma oportunidade/contrato fechado.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| opportunity_id | UUID | não | FK crm.opportunities |
| contract_id | UUID | não | FK legal.contracts |
| beneficiary_user_id | UUID | sim | FK core.users |
| base_amount | DECIMAL(18, 2) | sim |  |
| percentage | DECIMAL(9, 6) | sim |  |
| total_amount | DECIMAL(18, 2) | sim |  |
| rule_version_id | UUID | não | Rastreabilidade: versão da regra que gerou o valor (core.rule_versions) |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.commission_installments` (model `CommissionInstallment`)

Parcela de pagamento de uma comissão.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| commission_id | UUID | sim | FK finance.commissions |
| installment_number | INTEGER | sim |  |
| amount | DECIMAL(18, 2) | sim |  |
| due_at | DATE | sim |  |
| paid_at | DATE | não |  |
| financial_entry_id | UUID | não | FK finance.financial_entries |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.owner_repasses` (model `OwnerRepass`)

Repasse de valores líquidos ao proprietário do imóvel após locação/venda.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| property_id | UUID | sim | FK real_estate.properties |
| owner_person_id | UUID | sim | FK people.persons |
| contract_id | UUID | não | FK legal.contracts |
| bank_account_id | UUID | não | FK finance.bank_accounts |
| gross_amount | DECIMAL(18, 2) | sim |  |
| deductions_amount | DECIMAL(18, 2) | sim |  |
| net_amount | DECIMAL(18, 2) | sim |  |
| reference_month | STRING(7) | não | YYYY-MM |
| status | STRING(32) | sim |  |
| idempotency_key | STRING(128) | não | unique |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `finance.tax_documents` (model `TaxDocument`)

Documento fiscal emitido/recebido (NFS-e, DIMOB, comprovante de retenção).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| contract_id | UUID | não | FK legal.contracts |
| financial_entry_id | UUID | não | FK finance.financial_entries |
| document_type | STRING(32) | sim | NFSE|DIMOB|WITHHOLDING_RECEIPT |
| document_number | STRING(64) | não |  |
| issued_at | DATE | não |  |
| amount | DECIMAL(18, 2) | não |  |
| file_id | UUID | não | FK people.files |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
