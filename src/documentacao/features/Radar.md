# Radar (`src/features/radar/`)

CRUD de `crm.property_radars` (perfil de busca de um cliente) com matching determinístico
contra `real_estate.properties`/`property_offers`. RLS ativo (`tenant_isolation` em
`company_id`). Toda rota passa por `auth.middleware` **e** `tenant.middleware`, e toda
query roda dentro da transação de `req.withTenantTransaction`.

Todas as rotas exigem `Authorization: Bearer <accessToken>`.

## Rotas

| Método | Rota | Permissão |
|---|---|---|
| POST | `/api/v1/radar` | `radar:create` |
| GET | `/api/v1/radar` | `radar:read` |
| GET | `/api/v1/radar/:id` | `radar:read` |
| PATCH | `/api/v1/radar/:id` | `radar:update` |
| DELETE | `/api/v1/radar/:id` (soft delete) | `radar:delete` |
| GET | `/api/v1/radar/:id/matches` | `radar:read` |

## Payload de criação

```json
{
  "personId": "<uuid>",
  "opportunityId": "<uuid>",
  "criteriaJson": {
    "propertyType": "RESIDENTIAL",
    "offerType": "SALE",
    "city": "São Paulo",
    "minPrice": 350000,
    "maxPrice": 500000,
    "minAreaM2": 60,
    "maxAreaM2": 120
  }
}
```

Ao criar ou atualizar (`PATCH`) um radar, o matching roda **imediatamente** e os matches
atuais voltam no corpo da resposta em `data.matches` (além de poderem ser recalculados a
qualquer momento via `GET /radar/:id/matches`).

## Critérios de matching suportados (`criteriaJson`)

Todos os critérios são opcionais — um critério ausente simplesmente não filtra por ele:

| Critério | Compara contra |
|---|---|
| `propertyType` | `properties.property_type` (exato) |
| `offerType` | `property_offers.offer_type` da offer `ACTIVE` (exato) |
| `minPrice` / `maxPrice` | `property_offers.price_amount` da offer `ACTIVE` (faixa `>=`/`<=`) |
| `city` | `properties.city` (case-insensitive, `ILIKE`) |
| `state` | `properties.state` (case-insensitive, `ILIKE`) |
| `minAreaM2` / `maxAreaM2` | `properties.area_total_m2` (faixa `>=`/`<=`) |

## Matching determinístico

`matchRadarToProperties(radar, transaction)` (`src/features/radar/radar.service.js`) monta
os critérios acima em `WHERE` clauses diretas via Sequelize (`Op.gte`/`Op.lte`/`Op.iLike`)
sobre `Property` com `INCLUDE required: true` em `PropertyOffer` filtrada por
`status: 'ACTIVE'` — **não há heurística difusa, scoring ou machine learning**: uma property
só aparece no resultado se atender **simultaneamente** a todos os critérios preenchidos, e o
resultado é o mesmo para os mesmos dados de entrada em qualquer execução (propriedade
determinística, testável e auditável).

**Ordem de prioridade do resultado**: ordenado por `offers.created_at DESC` — a offer
`ACTIVE` mais recentemente criada (dentre as que batem) aparece primeiro. Não há outro
critério de ranking nesta versão.

Uma property com offer `PAUSED`/`SUPERSEDED`/`CLOSED` (nenhuma `ACTIVE` do `offerType`
pedido) nunca aparece nos matches — o filtro de offer `ACTIVE` é obrigatório sempre que
`offerType` é informado no radar.

## Erros comuns

- `400 RADAR_VALIDATION` — `personId`/`criteriaJson` ausentes.
- `404 RADAR_NOT_FOUND` — inclui o caso "existe mas pertence a outro tenant" (RLS).
- `404 PERSON_NOT_FOUND` / `OPPORTUNITY_NOT_FOUND` — ao referenciar IDs inexistentes.
