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
| POST | `/api/v1/opportunities/:id/tasks` | `crm:tasks:create` |
| GET | `/api/v1/opportunities/:id/tasks` | `crm:tasks:read` |
| GET | `/api/v1/opportunities/:id/timeline` | `crm:opportunities:read` |
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

Uma opportunity é considerada **ativa** quando seu `stage` **não** é `WON` nem
`LOST` (`isActiveStage`, `crm/opportunities.service.js`). Toda opportunity ativa
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

Opportunities fechadas (`WON`/`LOST`) **não** exigem `nextAction` e recebem
`closedAt` automaticamente ao entrar nesse estágio; se um `PATCH` mover a opportunity de
volta para um estágio ativo, `closedAt` é limpo novamente.

### Domain events

Toda criação de opportunity e toda mudança de `stage` (via `PATCH` com `stage` diferente do
atual) publica `crm.opportunity.stage_changed` via `publishDomainEvent` (Transactional
Outbox — mesma transação da escrita de domínio), com payload `{ id, fromStage, toStage }`.

## Tarefas da oportunidade (M3-11)

`opportunityTasks.service.js` grava em `core.tasks` (tabela polimórfica que já existia, com
RLS real) usando `related_entity_type = 'crm.opportunities'` e
`related_entity_id = <opportunity.id>`. **Não** existe tabela própria de tarefa de CRM: a
caixa de tarefas do usuário continua sendo uma consulta só, servindo contrato, cobrança e
oportunidade. `next_action` continua sendo a próxima ação obrigatória do funil; as tarefas
são o plano de trabalho ao redor dela.

- `status`: `OPEN|IN_PROGRESS|DONE|CANCELED`; `priority`: `LOW|NORMAL|HIGH|URGENT`.
- Responsável (`assignedToUserId`) precisa ser um usuário **ACTIVE** — atribuir a um usuário
  suspenso falha com `422 OPPORTUNITY_TASK_ASSIGNEE_NOT_ACTIVE`.
- Toda criação grava auditoria `opportunity.task_create`.

## Timeline unificada (M3-19)

`GET /api/v1/opportunities/:id/timeline` devolve, num array único ordenado do mais recente
para o mais antigo, os itens de todas as fontes da negociação: `MESSAGE` (crm.messages),
`VISIT` (crm.visits, posicionada pela data agendada), `PROPOSAL` (crm.proposals), `TASK`
(core.tasks) e `STAGE_CHANGE`/`OPPORTUNITY_CREATED` (lidos de `audit.audit_log`). Aceita
`?types=MESSAGE,VISIT` para filtrar.

A timeline é **derivada na leitura** — não há tabela de eventos a manter nem risco de
divergir das entidades. As mudanças de estágio vêm da auditoria (registro permanente e
append-only), não do outbox (fila de entrega, podável depois do despacho).

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

Visita **prospectiva** (`SCHEDULED`/`CONFIRMED`) não pode ser marcada nem reagendada para uma
data no passado (`422 VISIT_SCHEDULED_IN_THE_PAST`, tolerância de 5 min para desvio de
relógio). Registrar depois do fato uma visita que já aconteceu continua valendo — basta usar
`DONE`, `NO_SHOW` ou `CANCELED`.

## Messages — append-only

`crm.messages` não tem `deleted_at` no schema (não é `paranoid` no model) — é append-only
por design: histórico de atendimento nunca é apagado nem o `body` é editado.

Canais aceitos (enum fechado): `WHATSAPP|EMAIL|SMS|PHONE|IN_PERSON|PORTAL|INSTAGRAM|OTHER`.

O service expõe apenas `create`/`list`/`get` e um `PATCH /:id/status` restrito (ex.: `RECEIVED` ->
`READ`). Envio duplicado do mesmo `externalMessageId` (webhook reentregue) retorna a
mensagem já existente da MESMA empresa em vez de duplicar; o mesmo id em outra empresa é outra
mensagem (único por empresa, DI-M9R-10). O autor (`authorUserId`) não vem do corpo: é sempre
quem faz o pedido (DI-M9R-9). Campo de referência (`personId`, `opportunityId`,
`conversationId`, `mediaQuarantineId`) que não seja um UUID em texto, e `externalMessageId`
ou `body` que não sejam texto, dão 400 `MESSAGE_VALIDATION` (DI-M9R-8).

Esquema fechado por rota (DI-M9R-11, `src/features/crm/messages.schema.js`, validado com Ajv
em `messages.validate.js` antes do controller): o id do caminho, a consulta e o corpo de
`POST /messages`, `POST /messages/send`, `PATCH /messages/:id/status`,
`POST /messages/:id/send-alternate`, `POST /messages/:id/refresh-status`, `GET /messages` e
`GET /messages/:id` passam inteiros pelo esquema da rota. Campo que a rota não conhece, tipo
errado (sem conversão), valor fora da lista fechada ou do formato do banco, ou texto acima do
tamanho da coluna é 400 `MESSAGE_VALIDATION`, com o nome do campo na mensagem e todos os
campos recusados em `details.fields`. Nenhuma forma de entrada chega ao banco ou a um
`String()`. Pontos do contrato:
- `actionKey` não é aceito em `POST /messages` (a chave de idempotência só nasce pelas
  automações e campanhas, M9-D415); use `externalMessageId` para não repetir um registro.
- `authorUserId`, `connectionId`, `dispatchId`, `deliveryStatus`, `groupId` e `companyId`
  continuam aceitos e descartados (definidos pelo servidor).
- `purpose` só no formato da CHECK (`^[A-Za-z0-9_]{2,40}$`); fora dele é 400 (antes ficava nulo).
- `PATCH /messages/:id/status`: `status` só de `RECEIVED|QUEUED|SENT|DELIVERED|READ|FAILED|CANCELLED|UNKNOWN`
  (maiúsculas ou minúsculas); o corpo só tem `status`.
- `POST /messages/send`: `kind` só `text|template|media` (exato, em texto); `templateVars` só
  lista de textos; `mediaRef` UUID; `to`, `templateName`, `language`, `text`, `caption` em texto.
  Telefone fora do E.164 continua 422 `INTEGRATION_MESSAGING_PHONE_INVALID` (M9-D229) e modelo
  ou idioma fora dos aprovados, 422 `INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED` (M9-D230).
- `send-alternate` e `refresh-status` não têm corpo (qualquer campo é 400); `GET /messages`
  aceita só `personId` e `opportunityId`. Id de caminho que não é UUID: 400 `MESSAGE_VALIDATION`
  (antes `INVALID_ID_FORMAT`, pelo erro do banco).
- Rodada 6 (12/11/2026): a consulta é fechada em todas as rotas; só `GET /messages` tem filtros
  (`GET /messages/:id?x=1` é 400 com o nome do parâmetro, antes era ignorado).
- Tamanho do texto livre (DI-M9R-16), por parâmetro da empresa com o teto do canal: `text` até
  `integration.whatsapp.max_text_chars` (4096), `caption` até `max_caption_chars` (1024), cada item
  de `templateVars` até `max_template_var_chars` (1024; teto 32768) e o `body` de `POST /messages`
  até `integration.messaging.record_body_max_chars` (65536). Caractere = ponto de código (emoji = 1).
  Acima: 400 `MESSAGE_VALIDATION` com o campo e `details.maxChars`.
- Para toda a API (DI-M9R-14 e DI-M9R-15): corpo em charset ou `Content-Encoding` não aceito é 415
  (`REQUEST_BODY_CHARSET_UNSUPPORTED`, `REQUEST_BODY_ENCODING_UNSUPPORTED`), corpo comprimido
  quebrado é 400 `REQUEST_BODY_DECOMPRESSION_FAILED`, escape `%` malformado no caminho é 400
  `INVALID_ID_FORMAT`, e texto com caractere nulo ou metade solta de par sub-rogado, no corpo ou na
  consulta, é 400 `INVALID_TEXT_CHARACTER` (o banco não grava esses caracteres).

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
- `400 MESSAGE_VALIDATION` — pedido fora do esquema da rota de mensagem (DI-M9R-11): campo desconhecido, tipo errado, fora da lista fechada ou do formato.
- `422 VISIT_SCHEDULED_IN_THE_PAST` — visita prospectiva agendada para o passado.
- `400 OPPORTUNITY_TASK_VALIDATION` / `422 OPPORTUNITY_TASK_ASSIGNEE_NOT_ACTIVE` — tarefas de oportunidade.
- `404 OPPORTUNITY_NOT_FOUND` / `VISIT_NOT_FOUND` / `MESSAGE_NOT_FOUND`.
  - Mensagem fora do escopo da empresa da sessão (outra empresa ou id inexistente) é sempre `404 MESSAGE_NOT_FOUND`, também em `POST /messages/:id/send-alternate`; o `409 INTEGRATION_MESSAGING_ALTERNATE_NOT_APPLICABLE` é só para a mensagem da própria empresa que não está na fila do WhatsApp. Em `POST /messages/send`, pessoa ou oportunidade fora do escopo dá `404 PERSON_NOT_FOUND` / `OPPORTUNITY_NOT_FOUND` antes de qualquer outra regra (nunca "sem consentimento").
- `404 PERSON_NOT_FOUND` / `PROPERTY_NOT_FOUND` — ao referenciar IDs inexistentes.
