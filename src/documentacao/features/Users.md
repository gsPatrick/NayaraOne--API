# Users (`src/features/users/`)

CRUD de `core.users` — identidade global autenticável (sem RLS; um usuário pode ter
`user_memberships` em múltiplas empresas). Senha sempre com hash `bcryptjs` (12 rounds);
`password_hash` **nunca** é serializado nas respostas HTTP (`users.service.js#toSafeJson`).

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/users` | `users:create` |
| GET | `/api/v1/users` | `users:read` |
| GET | `/api/v1/users/:id` | `users:read` |
| PATCH | `/api/v1/users/:id` | `users:update` |
| DELETE | `/api/v1/users/:id` (soft delete) | `users:delete` |

## Payload de criação
```json
{ "name": "Fulano", "email": "fulano@empresa.com", "password": "SenhaForte123" }
```
`name`, `email`, `password` obrigatórios; senha mínima de 8 caracteres. `email` é normalizado
(`lowercase`/`trim`) e deve ser único.

## Payload de atualização (parcial)
```json
{ "name": "Novo Nome", "status": "INACTIVE", "password": "NovaSenhaForte123" }
```

## Erros comuns
- `400 USER_VALIDATION` — campos obrigatórios ausentes.
- `400 USER_WEAK_PASSWORD` — senha com menos de 8 caracteres.
- `409 USER_EMAIL_TAKEN` — e-mail já cadastrado.
- `404 USER_NOT_FOUND`.

## Nota de segurança
A criação/edição de usuário aqui **não** cria automaticamente um vínculo
(`core.user_memberships`) — isso é responsabilidade da feature `memberships`. Um usuário
recém-criado não consegue logar em nenhum tenant até receber um vínculo `ACTIVE`.
