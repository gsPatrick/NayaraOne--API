# People (`src/features/people/`)

CRUD de `people.persons` + sub-recursos `person_contacts`, `person_documents` e
`person_roles` — todas com RLS (`tenant_isolation` em `company_id`). Toda rota passa por
`auth.middleware` **e** `tenant.middleware`, e toda query roda dentro da transação de
`req.withTenantTransaction`.

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

## Rotas

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/people` | `people:create` |
| GET | `/api/v1/people` | `people:read` |
| GET | `/api/v1/people/:id` | `people:read` |
| PATCH | `/api/v1/people/:id` | `people:update` |
| DELETE | `/api/v1/people/:id` (soft delete) | `people:delete` |
| POST | `/api/v1/people/:id/contacts` | `people:update` |
| GET | `/api/v1/people/:id/contacts` | `people:read` |
| PATCH | `/api/v1/people/:id/contacts/:contactId` | `people:update` |
| DELETE | `/api/v1/people/:id/contacts/:contactId` | `people:update` |
| POST | `/api/v1/people/:id/documents` | `people:update` |
| GET | `/api/v1/people/:id/documents` | `people:read` |
| PATCH | `/api/v1/people/:id/documents/:documentId` | `people:update` |
| DELETE | `/api/v1/people/:id/documents/:documentId` | `people:update` |
| POST | `/api/v1/people/:id/roles` | `people:update` |
| GET | `/api/v1/people/:id/roles` | `people:read` |
| PATCH | `/api/v1/people/:id/roles/:roleId` | `people:update` |
| DELETE | `/api/v1/people/:id/roles/:roleId` | `people:update` |

## Payload de criação de pessoa

```json
{
  "type": "INDIVIDUAL",
  "name": "Maria Silva",
  "taxId": "111.222.333-44",
  "contacts": [
    { "channel": "EMAIL", "value": "maria@exemplo.com", "isPrimary": true },
    { "channel": "PHONE", "value": "+55 11 99999-0000", "isPrimary": false }
  ],
  "documents": [
    { "documentType": "CPF", "documentNumber": "111.222.333-44" }
  ]
}
```

`taxId`/`documentNumber` são normalizados para dígitos antes de gravar (`onlyDigits`).
`type` deve ser `INDIVIDUAL` ou `COMPANY`; `groupId`/`companyId` nunca são lidos do corpo —
sempre vêm do tenant resolvido no JWT (`req.auth`), como defesa em profundidade além do RLS.

## Deduplicação (regra dura)

Antes de criar uma pessoa, `people.service.js` chama
`findPotentialDuplicate(personData, transaction)`, que verifica, dentro do tenant corrente:

1. Se `taxId` (normalizado para dígitos) já existe em outra `Person`.
2. Se algum contato marcado `isPrimary: true` (ou o único contato enviado, se apenas um for
   informado) já existe como contato primário de outra `Person`, no mesmo `channel`.

Se encontrar uma duplicata e o payload **não** enviar `"allowDuplicate": true`, a criação
falha com:

```json
{
  "success": false,
  "error": {
    "code": "PERSON_DUPLICATE",
    "message": "Já existe uma pessoa cadastrada com o mesmo documento ou contato principal. Envie \"allowDuplicate\": true para criar mesmo assim.",
    "details": { "existingPersonId": "<uuid>" }
  }
}
```
`HTTP 409 Conflict`. Enviar `"allowDuplicate": true` no payload de criação ignora a checagem
e cria a pessoa mesmo assim (uso: operador confirmou manualmente que não é duplicata real).

`findPotentialDuplicate` é exportada por `people.service.js` e reutilizável por qualquer
outro service que precise checar duplicidade de pessoa antes de um `INSERT` (ex.: futura
importação em lote, criação automática a partir de lead de CRM).

## Validação de documentos

`validateDocumentFormat(documentType, documentNumber)` valida formato básico para
`CPF` (11 dígitos) e `CNPJ` (14 dígitos) — outros tipos (`RG`, comprovantes etc.) não têm
formato fixo e não são validados por regex. Falha com `400 PERSON_DOCUMENT_INVALID_FORMAT`.

## Erros comuns

- `400 PERSON_VALIDATION` — `groupId`/`companyId`/`name` ausentes, ou `type` inválido.
- `400 PERSON_DOCUMENT_INVALID_FORMAT` — CPF/CNPJ com quantidade de dígitos errada.
- `409 PERSON_DUPLICATE` — pessoa já existe pelo critério de dedup (ver acima).
- `404 PERSON_NOT_FOUND` — inclui o caso "existe mas pertence a outro tenant" (RLS).
- `404 PERSON_CONTACT_NOT_FOUND` / `PERSON_DOCUMENT_NOT_FOUND` / `PERSON_ROLE_NOT_FOUND`.
- `400 PERSON_ROLE_VALIDATION` — `role` fora de `CLIENT|OWNER|TENANT|GUARANTOR|EMPLOYEE|SUPPLIER|BROKER`.
