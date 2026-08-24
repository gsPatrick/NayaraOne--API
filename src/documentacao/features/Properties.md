# Properties (`src/features/properties/`)

CRUD de `real_estate.properties` + sub-recursos `property_owners`, `property_offers` e
`property_price_history` — todas com RLS (`tenant_isolation` em `company_id`). Toda rota
passa por `auth.middleware` **e** `tenant.middleware`, e toda query roda dentro da transação
de `req.withTenantTransaction`.

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

## Rotas

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/properties` | `properties:create` |
| GET | `/api/v1/properties` | `properties:read` |
| GET | `/api/v1/properties/:id` | `properties:read` |
| PATCH | `/api/v1/properties/:id` | `properties:update` |
| DELETE | `/api/v1/properties/:id` (soft delete) | `properties:delete` |
| POST | `/api/v1/properties/:id/owners` | `properties:update` |
| GET | `/api/v1/properties/:id/owners` | `properties:read` |
| PATCH | `/api/v1/properties/:id/owners/:ownerId` | `properties:update` |
| DELETE | `/api/v1/properties/:id/owners/:ownerId` | `properties:update` |
| POST | `/api/v1/properties/:id/offers` | `properties:update` |
| GET | `/api/v1/properties/:id/offers` | `properties:read` |
| PATCH | `/api/v1/properties/:id/offers/:offerId` | `properties:update` |

## Payload de criação de imóvel

```json
{
  "title": "Apartamento 2 quartos - Centro",
  "propertyType": "RESIDENTIAL",
  "addressLine": "Rua Exemplo, 123",
  "city": "São Paulo",
  "state": "SP",
  "zipCode": "01000-000",
  "areaTotalM2": 65.5
}
```
`propertyType` deve ser um de `RESIDENTIAL|COMMERCIAL|LAND|RURAL`. Não há campo de preço em
`properties` — preço vive exclusivamente em `property_offers` (ver abaixo).

## Owners (`property_owners`)

Vincula a property a uma ou mais `Person` com percentual de propriedade:

```json
{ "personId": "<uuid>", "ownershipPct": 50.0 }
```

## Offers — ofertas como sub-recurso próprio

`property_offers` é um sub-recurso **próprio** — uma property pode ter múltiplas offers
(uma `SALE`, uma `RENT`, cada uma com preço/status/vigência independentes). O preço
"canônico" de uma property nunca é um campo solto: ele sempre deriva da offer `ACTIVE` do
tipo desejado.

### Criar offer

```
POST /api/v1/properties/:id/offers
{ "offerType": "SALE", "priceAmount": 450000.00 }
```

**Regra dura: nunca duas offers `ACTIVE` do mesmo `offerType` para a mesma property.** Ao
criar (ou atualizar status para) uma offer `ACTIVE`, `propertyOffers.service.js` busca
qualquer offer `ACTIVE` existente do mesmo `offerType` nessa property e a marca
`SUPERSEDED` automaticamente, na mesma transação — atômico, nunca há uma janela em que
ambas apareçam `ACTIVE`. Offers de `offerType` diferente (ex.: `SALE` e `RENT` na mesma
property) não se afetam entre si.

Status possíveis: `ACTIVE | SUPERSEDED | PAUSED | CLOSED`.

### Atualizar offer (preço e/ou status)

```
PATCH /api/v1/properties/:id/offers/:offerId
{ "priceAmount": 460000.00 }
```

### Price History — append-only

Toda vez que `priceAmount` muda (seja no `POST` inicial ou em qualquer `PATCH`
subsequente), um registro é **inserido** (nunca atualizado) em
`real_estate.property_price_history`, com `previousPrice`/`newPrice`/`changedAt`/
`changedByUserId`. O primeiro registro de uma offer tem `previousPrice: null`. Isso é
automático — nenhuma rota expõe escrita direta em `property_price_history`; é
responsabilidade exclusiva de `propertyOffers.service.js`.

## Erros comuns

- `400 PROPERTY_VALIDATION` — campos obrigatórios ausentes ou `propertyType` inválido.
- `400 PROPERTY_OFFER_VALIDATION` — `offerType`/`priceAmount`/`status` ausentes ou inválidos.
- `404 PROPERTY_NOT_FOUND` / `PROPERTY_OWNER_NOT_FOUND` / `PROPERTY_OFFER_NOT_FOUND`.
- `404 PERSON_NOT_FOUND` — ao vincular um `personId` inexistente como owner.
