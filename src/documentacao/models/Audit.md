# Schema `audit`

Tabelas do schema físico `audit` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `audit.audit_log` (model `AuditLog`)

Trilha de auditoria append-only — nunca UPDATE/DELETE por usuário comum.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| user_id | UUID | não | FK core.users |
| action | STRING(64) | sim |  |
| entity_type | STRING(128) | sim |  |
| entity_id | UUID | não |  |
| before_json | JSONB | não |  |
| after_json | JSONB | não |  |
| reason | TEXT | não |  |
| occurred_at | DATE | sim |  |
| session_id | UUID | não |  |
| ip_address | STRING(64) | não |  |
| correlation_id | UUID | não |  |
| rule_version_id | UUID | não | Versão da regra vigente no momento da ação, quando aplicável |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
