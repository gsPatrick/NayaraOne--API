# CRM (`src/features/crm/`)

CRUD de `crm.opportunities`, `crm.visits` e `crm.messages` — todas com RLS
(`tenant_isolation` em `company_id`). Toda rota passa por `auth.middleware` **e**
`tenant.middleware`, e toda query roda dentro da transação de `req.withTenantTransaction`.

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

## Rotas

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/opportunities` | `crm:opportunities:create` |
| GET | `/api/v1/opportunities` | `crm:opportunities:read` |
| GET | `/api/v1/opportunities/:id` | `crm:opportunities:read` |
| PATCH | `/api/v1/opportunities/:id` | `crm:opportunities:update` |
| DELETE | `/api/v1/opportunities/:id` (soft delete) | `crm:opportunities:delete` |
| POST | `/api/v1/visits` | `crm:visits:create` |
| GET | `/api/v1/visits` | `crm:visits:read` |
| GET | `/api/v1/visits/:id` | `crm:visits:read` |
| PATCH | `/api/v1/visits/:id` | `crm:visits:update` |
| DELETE | `/api/v1/visits/:id` (soft delete) | `crm:visits:delete` |
| POST | `/api/v1/messages` | `crm:messages:create` |
| GET | `/api/v1/messages` | `crm:messages:read` |
| GET | `/api/v1/messages/:id` | `crm:messages:read` |
| PATCH | `/api/v1/messages/:id/status` | `crm:messages:update` |

## Opportunities

```json
{
  "personId": "<uuid>",
  "propertyId": "<uuid>",
  "stage": "NEW",
  "temperature": "WARM",
  "expectedValue": 450000.00,
  "nextAction": "Ligar para confirmar visita",
  "nextActionDueAt": "2026-08-25T13:00:00.000Z"
}
```

### Regra dura: `next_action` obrigatório em opportunity ATIVA

Uma opportunity é considerada **ativa** quando seu `stage` **não** é `CLOSED_WON` nem
`CLOSED_LOST` (`isActiveStage`, `crm/opportunities.service.js`). Toda opportunity ativa
precisa ter `nextAction` **e** `nextActionDueAt` preenchidos — validado em
`assertNextActionWhenActive`, chamada tanto no `create` quanto no `update` (considerando o
estado final resultante do PATCH, não só os campos enviados). Violação falha com:

```json
{
  "success": false,
  "error": {
    "code": "OPPORTUNITY_NEXT_ACTION_REQUIRED",
    "message": "Oportunidades em estágio ativo exigem \"nextAction\" e \"nextActionDueAt\" preenchidos.",
    "details": { "stage": "NEW" }
  }
}
```
`HTTP 422 Unprocessable Entity`.

**Por que não um CHECK constraint**: `next_action`/`next_action_due_at` são colunas
`NULLABLE` a nível de schema (migration `20260101000074-add-next-action-to-crm-opportunities.js`)
porque a definição de "estágio ativo" depende do valor livre de `stage` (o funil pode se
tornar configurável por tenant em marcos futuros — um CHECK fixo em `stage NOT IN (...)`
engessaria isso no schema). A obrigatoriedade é aplicada exclusivamente na camada de
aplicação, antes de qualquer `INSERT`/`UPDATE` chegar ao banco.

Opportunities fechadas (`CLOSED_WON`/`CLOSED_LOST`) **não** exigem `nextAction` e recebem
`closedAt` automaticamente ao entrar nesse estágio; se um `PATCH` mover a opportunity de
volta para um estágio ativo, `closedAt` é limpo novamente.

### Domain events

Toda criação de opportunity e toda mudança de `stage` (via `PATCH` com `stage` diferente do
atual) publica `crm.opportunity.stage_changed` via `publishDomainEvent` (Transactional
Outbox — mesma transação da escrita de domínio), com payload `{ id, fromStage, toStage }`.

## Visits

```json
{
  "propertyId": "<uuid>",
  "opportunityId": "<uuid>",
  "personId": "<uuid>",
  "scheduledAt": "2026-08-25T14:00:00.000Z",
  "status": "SCHEDULED"
}
```
Status possíveis: `SCHEDULED|CONFIRMED|DONE|CANCELED|NO_SHOW`.

## Messages — append-only

`crm.messages` não tem `deleted_at` no schema (não é `paranoid` no model) — é append-only
por design: histórico de atendimento nunca é apagado nem o `body` é editado. O service
expõe apenas `create`/`list`/`get` e um `PATCH /:id/status` restrito (ex.: `RECEIVED` ->
`READ`). Envio duplicado do mesmo `externalMessageId` (webhook reentregue) retorna a
mensagem já existente em vez de duplicar.

```json
{
  "personId": "<uuid>",
  "opportunityId": "<uuid>",
  "channel": "WHATSAPP",
  "direction": "INBOUND",
  "authorType": "CLIENT",
  "body": "Olá, ainda está disponível?",
  "externalMessageId": "wamid.HBg..."
}
```

## Erros comuns

- `400 OPPORTUNITY_VALIDATION` — `personId` ausente ou `temperature` inválida.
- `422 OPPORTUNITY_NEXT_ACTION_REQUIRED` — opportunity ativa sem `nextAction`/`nextActionDueAt`.
- `400 VISIT_VALIDATION` — campos obrigatórios ausentes ou `status` inválido.
- `400 MESSAGE_VALIDATION` — `direction`/`authorType` ausentes ou inválidos.
- `404 OPPORTUNITY_NOT_FOUND` / `VISIT_NOT_FOUND` / `MESSAGE_NOT_FOUND`.
- `404 PERSON_NOT_FOUND` / `PROPERTY_NOT_FOUND` — ao referenciar IDs inexistentes.
