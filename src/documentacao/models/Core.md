# Schema `core`

Tabelas do schema físico `core` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `core.groups` (model `Group`)

Grupo empresarial — nível mais alto da hierarquia group -> company -> unit.

- Multiempresa (RLS): não
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| name | STRING(255) | sim |  |
| legal_name | STRING(255) | não |  |
| tax_id | STRING(32) | não | CNPJ/CPF do grupo, quando aplicável |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.companies` (model `Company`)

Empresa/pessoa jurídica operacional pertencente a um grupo.

- Multiempresa (RLS): não
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| name | STRING(255) | sim |  |
| legal_name | STRING(255) | não |  |
| tax_id | STRING(32) | não | CNPJ — unique |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.units` (model `Unit`)

Unidade/filial operacional dentro de uma empresa.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| name | STRING(255) | sim |  |
| code | STRING(64) | não |  |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.users` (model `User`)

Usuário autenticável do sistema (identidade).

- Multiempresa (RLS): não
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| name | STRING(255) | sim |  |
| email | STRING(255) | sim | unique |
| password_hash | STRING(255) | sim |  |
| mfa_enabled | BOOLEAN | sim |  |
| mfa_method | STRING(32) | não | TOTP | WEBAUTHN | PASSKEY — nunca SMS como preferencial |
| status | STRING(32) | sim |  |
| last_login_at | DATE | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.user_memberships` (model `UserMembership`)

Vínculo de um usuário a uma empresa/unidade, com papel(is) associados.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| user_id | UUID | sim | FK core.users |
| unit_id | UUID | não | FK core.units |
| status | STRING(32) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.roles` (model `Role`)

Papel RBAC atribuível a usuários.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| name | STRING(128) | sim |  |
| description | TEXT | não |  |
| is_system | BOOLEAN | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.permissions` (model `Permission`)

Permissão granular (catálogo global) referenciável por roles — ex. finance.entries.approve.

- Multiempresa (RLS): não
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| code | STRING(128) | sim | unique |
| description | TEXT | não |  |
| risk_level | STRING(16) | sim | LOW|MEDIUM|HIGH|CRITICAL |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.role_permissions` (model `RolePermission`)

Associação N:N entre roles e permissions.

- Multiempresa (RLS): não
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| role_id | UUID | sim | FK core.roles |
| permission_id | UUID | sim | FK core.permissions |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.substitutions` (model `Substitution`)

Substituição temporária de responsabilidade/aprovação entre usuários (férias, licença).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| substitute_user_id | UUID | sim | Usuário que assume — FK core.users |
| original_user_id | UUID | sim | Usuário substituído — FK core.users |
| starts_at | DATE | sim |  |
| ends_at | DATE | não |  |
| reason | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.tasks` (model `Task`)

Tarefa/atividade operacional atribuível a um usuário, ligada a qualquer entidade do sistema.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| assigned_to_user_id | UUID | não | FK core.users |
| title | STRING(255) | sim |  |
| description | TEXT | não |  |
| related_entity_type | STRING(64) | não | Tipo da entidade relacionada (polimórfico), ex. legal.contracts |
| related_entity_id | UUID | não |  |
| due_at | DATE | não |  |
| status | STRING(32) | sim |  |
| priority | STRING(16) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.notifications` (model `Notification`)

Notificação in-app/e-mail direcionada a um usuário.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| user_id | UUID | sim | FK core.users |
| channel | STRING(32) | sim |  |
| title | STRING(255) | sim |  |
| body | TEXT | não |  |
| read_at | DATE | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.system_settings` (model `SystemSetting`)

Configuração versionada por empresa (evita hard-code de valores de negócio na interface/código).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| key | STRING(128) | sim |  |
| value_json | JSONB | sim |  |
| description | TEXT | não |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rules` (model `Rule`)

Definição lógica de uma regra de negócio (cabeçalho); versão publicada é imutável.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| code | STRING(128) | sim | Identificador estável, ex. 'REG-FIN-001' |
| name | STRING(255) | sim |  |
| description | TEXT | não |  |
| domain | STRING(64) | não | Domínio de negócio ao qual a regra pertence |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_versions` (model `RuleVersion`)

Versão publicada e imutável de uma regra — nunca editada após publicação (rollback é nova publicação).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_id | UUID | sim | FK core.rules |
| version_number | INTEGER | sim |  |
| condition_ast_json | JSONB | sim | AST tipado da condição (DSL segura declarativa) |
| content_hash | STRING(64) | sim |  |
| action_json | JSONB | sim |  |
| effective_from | DATE | sim |  |
| effective_until | DATE | não |  |
| status | STRING(32) | sim | DRAFT|SIMULATED|PUBLISHED|RETIRED |
| published_by_user_id | UUID | não | FK core.users |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_scopes` (model `RuleScope`)

Escopo de aplicação de uma versão de regra na hierarquia de precedência (objeto/usuário/unidade/depto/empresa/grupo/global).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_version_id | UUID | sim | FK core.rule_versions |
| scope_type | STRING(32) | sim | OBJECT|USER|UNIT|DEPARTMENT|COMPANY|GROUP|GLOBAL |
| scope_ref_id | UUID | não |  |
| precedence | INTEGER | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_dependencies` (model `RuleDependency`)

Dependência explícita entre regras (grafo de dependências).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_id | UUID | sim | Regra dependente — FK core.rules |
| depends_on_rule_id | UUID | sim | Regra da qual depende — FK core.rules |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_exceptions` (model `RuleException`)

Exceção temporária a uma regra, com alvo, justificativa e prazo definidos.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_id | UUID | sim | FK core.rules |
| target_entity_type | STRING(64) | sim |  |
| target_entity_id | UUID | sim |  |
| justification | TEXT | sim |  |
| starts_at | DATE | sim |  |
| ends_at | DATE | sim |  |
| approved_by_user_id | UUID | não | FK core.users |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_approval_requests` (model `RuleApprovalRequest`)

Solicitação de aprovação segregada para publicação de uma versão de regra (quem cria não é o único aprovador).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_version_id | UUID | sim | FK core.rule_versions |
| requested_by_user_id | UUID | sim | FK core.users |
| status | STRING(32) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_approval_steps` (model `RuleApprovalStep`)

Etapa/decisão individual dentro de uma solicitação de aprovação de regra.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_approval_request_id | UUID | sim | FK core.rule_approval_requests |
| approver_user_id | UUID | sim | FK core.users |
| decision | STRING(16) | não | APPROVED|REJECTED |
| decided_at | DATE | não |  |
| comment | TEXT | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_publications` (model `RulePublication`)

Registro imutável de cada publicação efetiva de uma versão de regra.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_version_id | UUID | sim | FK core.rule_versions |
| published_by_user_id | UUID | sim | FK core.users |
| published_at | DATE | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_simulations` (model `RuleSimulation`)

Simulação obrigatória de uma versão de regra antes da publicação, com resultado.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_version_id | UUID | sim | FK core.rule_versions |
| requested_by_user_id | UUID | sim | FK core.users |
| input_facts_json | JSONB | sim |  |
| output_json | JSONB | não |  |
| status | STRING(32) | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_test_cases` (model `RuleTestCase`)

Caso de teste obrigatório associado a uma regra (executado antes da publicação).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_id | UUID | sim | FK core.rules |
| name | STRING(255) | sim |  |
| input_facts_json | JSONB | sim |  |
| expected_output_json | JSONB | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `core.rule_evaluation_log` (model `RuleEvaluationLog`)

Log append-only de cada avaliação de regra em produção (observabilidade/auditoria).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): não — tabela append-only
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| rule_version_id | UUID | sim | FK core.rule_versions |
| evaluated_at | DATE | sim |  |
| input_facts_json | JSONB | sim |  |
| decision | STRING(32) | sim |  |
| correlation_id | UUID | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
