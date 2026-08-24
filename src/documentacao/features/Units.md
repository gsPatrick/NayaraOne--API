# Units (`src/features/units/`)

CRUD de `core.units` — primeira tabela na cadeia `group -> company -> unit` com RLS
(`ENABLE` + `FORCE`, policy `tenant_isolation` em `company_id`). Por isso, toda rota passa
por `auth.middleware` **e** `tenant.middleware`, e toda query roda dentro da transação de
`req.withTenantTransaction`.

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/units` | `units:create` |
| GET | `/api/v1/units` | `units:read` |
| GET | `/api/v1/units/:id` | `units:read` |
| PATCH | `/api/v1/units/:id` | `units:update` |
| DELETE | `/api/v1/units/:id` (soft delete) | `units:delete` |

## Payload de criação
```json
{ "name": "Unidade Centro", "code": "UN-CENTRO" }
```
**`groupId`/`companyId` nunca são lidos do corpo da requisição** — o controller sempre usa
`req.auth.groupId`/`req.auth.companyId` (o tenant resolvido do JWT), como defesa em
profundidade além do RLS do Postgres (IAM-002 "segurança no servidor"). Um cliente que enviar
`groupId`/`companyId` no payload tem esses campos silenciosamente sobrescritos pelo tenant da
sessão.

## Erros comuns
- `400 UNIT_VALIDATION` — `name` ausente.
- `400 UNIT_COMPANY_MISMATCH` — inconsistência interna (não deveria ocorrer, já que
  group/company vêm do JWT).
- `404 UNIT_NOT_FOUND` — inclui o caso "existe mas pertence a outro tenant" (RLS faz o SELECT
  retornar vazio antes mesmo do 404 lógico ser calculado).
- `401 TENANT_CONTEXT_MISSING` — `tenant.middleware` não conseguiu resolver contexto (não
  deveria ocorrer se `auth.middleware` rodou antes com sucesso).
