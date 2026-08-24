# Groups (`src/features/groups/`)

CRUD de `core.groups` — topo da hierarquia `group -> company -> unit`. Tabela sem RLS (não
existe tenant acima de group para segregar); autorização é feita só via `requirePermission`.

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/groups` | `groups:create` |
| GET | `/api/v1/groups` | `groups:read` |
| GET | `/api/v1/groups/:id` | `groups:read` |
| PATCH | `/api/v1/groups/:id` | `groups:update` |
| DELETE | `/api/v1/groups/:id` (soft delete) | `groups:delete` |

## Payload de criação
```json
{ "name": "Grupo Exemplo", "legalName": "Grupo Exemplo Ltda", "taxId": "00.000.000/0001-00" }
```
`name` obrigatório. `status` default `ACTIVE`.

## Erros comuns
- `400 GROUP_VALIDATION` — `name` ausente.
- `404 GROUP_NOT_FOUND` — id inexistente ou já deletado (soft delete via `deleted_at`).
- `403 PERMISSION_DENIED` — token sem a permissão exigida pela rota.
- `401 MISSING_ACCESS_TOKEN` / `INVALID_ACCESS_TOKEN` — header ausente/token inválido.
