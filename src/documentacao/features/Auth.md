# Auth (`src/features/auth/`)

Módulo de autenticação por sessão JWT (access + refresh), com refresh token rotativo e
sessões persistidas em `core.sessions`.

## Variáveis de ambiente

Ver `ENV_REFERENCE.md`: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL` (default `15m`),
`JWT_REFRESH_TTL` (default `7d`).

## Endpoints (públicos — não exigem `Authorization`)

### `POST /api/v1/auth/login`
```json
{ "email": "admin@nayaraone.dev", "password": "DevAdmin#2026" }
```
Opcionalmente `companyId` para escolher entre múltiplos vínculos ativos do usuário. Sem
`companyId`, usa o vínculo `ACTIVE` mais antigo do usuário (fail closed se não houver nenhum).

Resposta 200:
```json
{
  "success": true,
  "data": {
    "accessToken": "...", "refreshToken": "...", "sessionId": "...",
    "user": { "id": "...", "name": "...", "email": "..." },
    "groupId": "...", "companyId": "...",
    "roles": ["ADMIN"], "permissions": ["groups:create", "..."]
  }
}
```

Erros comuns: `401 INVALID_CREDENTIALS` (e-mail/senha incorretos — mensagem genérica de
propósito, para não permitir enumeração de usuários), `403 NO_ACTIVE_MEMBERSHIP` (usuário
sem nenhum vínculo `core.user_memberships` ativo).

### `POST /api/v1/auth/refresh`
```json
{ "refreshToken": "<refresh token recebido no login>" }
```
Rotaciona o refresh token: a sessão antiga é revogada e uma nova é criada — o token antigo
não pode mais ser reutilizado (mitigação a refresh token reuse, IAM-TS-004). Retorna o mesmo
formato de claims do login (sem o campo `user`).

Erros comuns: `401 SESSION_INVALID` (sessão inexistente, revogada ou expirada — inclui o
caso de reuso do refresh token antigo após rotação).

### `POST /api/v1/auth/logout`
```json
{ "refreshToken": "<refresh token a ser revogado>" }
```
Idempotente — refresh token já revogado/inexistente/expirado não é erro, apenas retorna
`{ "revoked": false }`.

## Claims do access token (JWT)
```
sub          -> user id
group_id     -> tenant group ativo
company_id   -> tenant company ativo
roles        -> nomes dos papéis (core.roles.name) resolvidos no login
permissions  -> códigos (core.permissions.code) resolvidos via core.role_permissions
iat / exp
```
Roles/permissões são resolvidas **no momento do login/refresh** (não em cada request) — uma
alteração de permissão só passa a valer para sessões novas/renovadas. Ver
`src/features/memberships/memberships.service.js#getEffectiveAccess`.

## Pendência conhecida (documentada, não escondida)
O bootstrap de login (`resolveActiveTenant`) consulta `core.user_memberships`, que tem RLS
`FORCE ROW LEVEL SECURITY`, **antes** de existir qualquer `company_id` de sessão para fazer
`SET LOCAL`. Em ambiente local de desenvolvimento isso funciona porque o role do Postgres
usado (`patrick.developer`) é `SUPERUSER`/`BYPASSRLS`, então a RLS é ignorada mesmo com
FORCE. **Em produção, o role de runtime (`nayara_runtime`) não deve ser superuser** — este é
um item pendente para o Marco 3+: expor um caminho de bootstrap de login que não dependa de
bypass de RLS (ex. função `SECURITY DEFINER` restrita a `(user_id) -> memberships mínimas`,
ou uma tabela/view sem RLS dedicada apenas à etapa de descoberta de tenant no login).
