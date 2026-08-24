# Memberships (`src/features/memberships/`)

Gestão de `core.user_memberships` — vínculo de um usuário a um `group`/`company` (e
opcionalmente `unit`), com um papel RBAC (`core.roles`, via a coluna `role_id` — adicionada
por migration EXPAND `20260101000073-add-role-id-to-core-user_memberships.js`, nullable por
compatibilidade). Tabela com RLS (`company_id`) — rotas usam `auth.middleware` +
`tenant.middleware`.

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/memberships` | `memberships:create` |
| GET | `/api/v1/memberships?userId=&companyId=` | `memberships:read` |
| DELETE | `/api/v1/memberships/:id` (revoga — `status=REVOKED`, não deleta) | `memberships:delete` |
| GET | `/api/v1/memberships/:userId/effective-permissions?companyId=` | `memberships:read` |

## Payload de criação
```json
{ "userId": "<uuid>", "unitId": "<uuid opcional>", "roleId": "<uuid opcional de core.roles>" }
```
`groupId`/`companyId` nunca são lidos do corpo — sempre o tenant do JWT (mesma defesa em
profundidade de `units.controller.js`). Validações: `unitId` (se informado) precisa
pertencer à `companyId` do tenant; `roleId` (se informado) idem.

## `GET /:userId/effective-permissions`
Resolve, a partir de todos os `user_memberships` `ACTIVE` do usuário na `companyId`
informada (ou a do tenant do token, se omitida), os `roles` e a união de `permissions`
(via `core.role_permissions` -> `core.permissions.code`). É o mesmo cálculo usado no login
para montar as claims do JWT (`src/features/memberships/memberships.service.js#getEffectiveAccess`,
reaproveitado por `auth.service.js`).

Resposta:
```json
{ "userId": "...", "companyId": "...", "roles": [{ "id": "...", "name": "ADMIN" }], "permissions": ["groups:create", "..."], "unitIds": [] }
```

## Erros comuns
- `400 MEMBERSHIP_VALIDATION` — `userId` ausente.
- `400 MEMBERSHIP_UNIT_MISMATCH` / `MEMBERSHIP_ROLE_MISMATCH` — unidade/role de outro tenant.
- `404 MEMBERSHIP_NOT_FOUND`.
