# Motor de Eventos — Outbox/Inbox (`src/engines/events/`)

Implementação inicial (Marco 2) do padrão Transactional Outbox descrito em
`Maturacao/03_MOTORES_TRANSVERSAIS.md §2`. Módulo de biblioteca, sem rotas HTTP próprias —
consumido por services de domínio.

## `publishDomainEvent(event, transaction)` (`outbox.js`)
Grava em `integration.outbox_events` **dentro da mesma transação** da operação de negócio:
```js
await req.withTenantTransaction(async (transaction) => {
  const unit = await Unit.create({ ... }, { transaction });
  await publishDomainEvent({
    groupId: req.auth.groupId, companyId: req.auth.companyId,
    aggregateType: 'Unit', aggregateId: unit.id,
    eventType: 'unit.created', payload: { id: unit.id, name: unit.name },
    idempotencyKey: `unit.created:${unit.id}`,
  }, transaction);
  return unit;
});
```
`idempotencyKey` é obrigatória (coluna `UNIQUE`) — se a transação falhar, dado de negócio e
evento falham juntos (rollback atômico); nunca se grava o dado e tenta publicar direto no
broker fora da transação.

## `dispatchPendingEvents({ limit })` (`outbox-dispatcher.js`)
Lê um lote de `outbox_events` com `status='PENDING'` via `SELECT ... FOR UPDATE SKIP LOCKED`
(permite múltiplos workers concorrentes sem processar o mesmo evento duas vezes), "publica"
(nesta etapa, apenas `console.log` — ver decisão de design abaixo) e marca `DISPATCHED`.
Retry por classe `TRANSIENT` com backoff `1min / 5min / 15min / 1h / 4h` (`RETRY_BACKOFF_MS`);
após 5 tentativas, vai para `status='DEAD_LETTER'` com `dead_letter_reason`.

**Como plugar um broker real depois**: trocar apenas a função `publishToBroker(event)` em
`outbox-dispatcher.js` por uma chamada real ao adapter do broker (RabbitMQ, conforme
`03_MOTORES_TRANSVERSAIS.md §2.2` — exchange `nayara.events`, routing key
`<domain>.<event>`); o contrato de leitura/lock/retry do outbox permanece o mesmo.

Não há, nesta etapa, um processo/cron que chame `dispatchPendingEvents` automaticamente — a
função é exportada e pronta para ser agendada (worker separado / `setInterval` / job
scheduler) no Marco em que o primeiro consumidor real existir.

## `consumeInboundEvent({ sourceId, eventId, groupId, companyId, payload }, handlerFn)` (`inbox.js`)
Deduplicação de consumo via `integration.integration_inbox`
(`idempotency_key = "<sourceId>:<eventId>"`, `UNIQUE`). Um evento já visto (qualquer status)
não roda `handlerFn` de novo — retorna `{ processed: false, duplicate: true, status }`.
`handlerFn` roda dentro da mesma transação que grava o registro de inbox; se lançar, o
registro fica `status='FAILED'` com `dead_letter_reason` e a transação inteira é revertida
(o handler não pode ter aplicado metade do efeito colateral).

**Nota**: `integration_inbox.event_id` é `UUID` no schema atual — eventos externos com
identificador não-UUID (ex. IDs de webhook de terceiros) precisam ser normalizados (hash
determinístico -> UUID) antes de chamar `consumeInboundEvent`; isso não foi necessário nesta
etapa por não haver ainda nenhum consumidor real de webhook implementado.

## Decisão de design (para revisão)
**Sem broker real (RabbitMQ) nesta etapa** — decisão deliberada para o escopo Marco 1/2, que
pede "estrutura base" dos motores. O outbox é funcional e testado ponta a ponta
(gravação transacional + leitura concorrente com lock + retry/DLQ), mas o "publish" real é um
stand-in (`console.log`) documentado explicitamente aqui e no código
(`outbox-dispatcher.js#publishToBroker`), para não passar a falsa impressão de que há
integração de mensageria real ainda. Isso é compatível com ARC-008 ("Operação sem IA/broker
não interrompe processos básicos") — o outbox nunca bloqueia a transação de negócio,
independente de haver broker plugado ou não.
