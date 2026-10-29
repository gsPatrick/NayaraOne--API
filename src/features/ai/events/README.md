# events
Eventos `ai.*` da NAY no outbox transacional (M9-D029). `publishAiEvent(tenant, tipo, dados, transacao)` valida contra o catálogo
(`aiEvents.catalog.js`), monta o payload só com os campos listados, recusa dado pessoal (500 `AI_OUTBOX_EVENT_INCOMPLETE`) e grava
com `publishDomainEvent` na MESMA transação do dado, `eventVersion` 1 e a chave de idempotência da tabela da demanda. Os helpers de
`aiEvents.js` (`publishRunEvent`, `publishRecommendationEvent`, `publishToolCallBlocked`, `publishBudgetThreshold`,
`publishInjectionDetected`) são o único caminho: nenhum outro arquivo da NAY chama `publishDomainEvent` para esses sete eventos.
