# Schema `people`

Tabelas do schema físico `people` (fonte: Maturacao/02_BANCO_DE_DADOS_E_RLS.md §2.1-2.11 e, para o Motor de Regras, §1.4 de 03_MOTORES_TRANSVERSAIS.md).

## `people.persons` (model `Person`)

Pessoa física ou jurídica cadastrada (cliente, proprietário, fornecedor, colaborador etc.).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): sim

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| type | STRING(16) | sim | INDIVIDUAL|COMPANY |
| name | STRING(255) | sim |  |
| tax_id | STRING(32) | não | CPF/CNPJ — PII, mascarado na camada de aplicação |
| birth_date | DATE | não |  |
| status | STRING(32) | sim |  |
| lock_version | INTEGER | sim | otimista, default 0 |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `people.person_roles` (model `PersonRole`)

Papel de negócio que uma pessoa assume (cliente, proprietário, inquilino, fiador, colaborador, fornecedor).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| person_id | UUID | sim | FK people.persons |
| role | STRING(32) | sim | CLIENT|OWNER|TENANT|GUARANTOR|EMPLOYEE|SUPPLIER|BROKER |
| starts_at | DATE | não |  |
| ends_at | DATE | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `people.person_contacts` (model `PersonContact`)

Canal de contato de uma pessoa (telefone, e-mail, WhatsApp).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| person_id | UUID | sim | FK people.persons |
| channel | STRING(16) | sim | PHONE|EMAIL|WHATSAPP |
| value | STRING(255) | sim |  |
| is_primary | BOOLEAN | sim |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `people.person_documents` (model `PersonDocument`)

Documento formal vinculado a uma pessoa (RG, CPF, comprovante, contrato social).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| person_id | UUID | sim | FK people.persons |
| document_type | STRING(64) | sim |  |
| document_number | STRING(64) | não |  |
| issued_at | DATE | não |  |
| expires_at | DATE | não |  |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `people.files` (model `File`)

Metadado de arquivo binário — o binário em si vive em storage dedicado (S3-compatível), nunca no banco relacional.

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| storage_key | STRING(512) | sim | Chave/caminho no storage externo |
| file_name | STRING(255) | sim |  |
| mime_type | STRING(128) | não |  |
| size_bytes | INTEGER | não |  |
| checksum_sha256 | STRING(64) | não |  |
| uploaded_by_user_id | UUID | não | FK core.users |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |

## `people.file_links` (model `FileLink`)

Vínculo polimórfico de um arquivo a qualquer entidade do sistema (contrato, imóvel, RDO etc.).

- Multiempresa (RLS): sim (group_id, company_id)
- Soft delete (paranoid): sim (deleted_at/deleted_by)
- Controle de concorrência (lock_version): não

| Coluna | Tipo | Obrigatório | Observação |
|---|---|---|---|
| id | UUID | sim | PK |
| group_id | UUID | sim | FK core.groups |
| company_id | UUID | sim | FK core.companies |
| file_id | UUID | sim | FK people.files |
| related_entity_type | STRING(64) | sim |  |
| related_entity_id | UUID | sim |  |
| purpose | STRING(64) | não | Finalidade do vínculo, ex. CONTRACT_SIGNED_PDF |
| created_by / updated_by | UUID | não | auditoria de autoria |
| deleted_at / deleted_by | DATE / UUID | não | soft delete |
| created_at / updated_at | TIMESTAMPTZ | sim | automático |
