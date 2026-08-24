# Companies (`src/features/companies/`)

CRUD de `core.companies`, sempre vinculada a um `groupId` existente. Tabela sem RLS própria
(a policy de tenant começa a valer a partir de `units`/`user_memberships`/`roles` em diante).

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/companies` | `companies:create` |
| GET | `/api/v1/companies?groupId=` | `companies:read` |
| GET | `/api/v1/companies/:id` | `companies:read` |
| PATCH | `/api/v1/companies/:id` | `companies:update` |
| DELETE | `/api/v1/companies/:id` (soft delete) | `companies:delete` |

## Payload de criação
```json
{ "groupId": "<uuid de core.groups>", "name": "Empresa Exemplo", "taxId": "00.000.000/0001-00" }
```
`groupId` e `name` obrigatórios; `groupId` precisa existir (`400 COMPANY_GROUP_NOT_FOUND`
caso contrário).

## Erros comuns
- `400 COMPANY_VALIDATION` — `groupId`/`name` ausentes.
- `400 COMPANY_GROUP_NOT_FOUND` — `groupId` não existe.
- `404 COMPANY_NOT_FOUND`.
- `409 UNIQUE_CONSTRAINT_VIOLATION` — `taxId` já usado por outra empresa.
