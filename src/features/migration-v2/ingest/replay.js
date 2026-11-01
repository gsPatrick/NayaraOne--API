'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { MODES } = require('./ingest.constants');
const errors = require('./ingest.errors');
const connectors = require('./connectors');
const cdc = require('./cdc.reader');
const watermark = require('./watermark.reader');
const fulldiff = require('./fulldiff.reader');
const sources = require('./source.repository');
const batches = require('./batch.repository');
const { runBatch, loadSettings } = require('./batch.runner');
const runs = require('./run.repository');
const limiter = require('./run.limiter');
const { admitReplay } = require('./run.admission');
const heartbeat = require('./run.heartbeat');

const finishTicket = (tenant, id, status, error) => openTenantTx(tenant, (transaction) => runs.finish(tenant, id, status, { replay: true }, error, transaction));

/**
 * Replay de um intervalo já aplicado (M9-D900 §3.4 e §3.5): relê da origem o mesmo intervalo do lote `batchId` e o reaplica como um NOVO lote (novo id, `replay_of` = lote
 * original). O lote original NÃO muda de estado; como o aplicador é idempotente (chave `<sistema>:<entidade>:<chave>:<posição>`), o estado final e o `root_hash` são os mesmos
 * e nenhuma linha nem chave de idempotência se duplica. O checkpoint nunca recua nem avança num replay. Devolve { batch, counts }.
 */
async function replayBatch(tenant, actor, batchId) {
  const original = await openTenantTx(tenant, (transaction) => batches.get(tenant, batchId, transaction));
  if (!original) throw errors.batchNotFound();
  if (original.from_token === null && original.to_token === null) throw errors.runInvalid('Lote de exclusões não tem intervalo para repetir.');
  const settings = await loadSettings(tenant);
  const source = await openTenantTx(tenant, (transaction) => sources.get(tenant, original.source_id, transaction));
  // O replay relê o legado como uma execução: passa pelos mesmos limites (por fonte, por empresa e por processo) antes de abrir a conexão (N3).
  const ticket = await openTenantTx(tenant, (transaction) => admitReplay(tenant, actor, { sourceSystem: source.source_system, entity: source.entity }, transaction));
  if (!limiter.tryAcquire(settings.maxInProcess)) {
    await finishTicket(tenant, ticket.id, 'FAILED', 'Sem vaga no processo para o replay.');
    throw errors.runLimit();
  }
  let connector = null;
  let stopSignal = () => {};
  try {
    stopSignal = await heartbeat.start(tenant, ticket.id);
    connector = await connectors.open(source);
    const range = { fromToken: original.from_token, toToken: original.to_token };
    let events;
    if (source.mode === MODES.CDC) events = await cdc.readRange(connector, range);
    else if (source.mode === MODES.WATERMARK) events = await watermark.readRange(connector, range);
    else events = await fulldiff.readRange(connector, source, range);
    const result = await runBatch(tenant, actor, original.run_id, source, { ...range, events }, { replayOf: original.id, settings });
    await finishTicket(tenant, ticket.id, 'SUCCEEDED', null);
    return result;
  } catch (err) {
    await finishTicket(tenant, ticket.id, 'FAILED', String((err && err.message) || err).slice(0, 500)).catch(() => {});
    throw err;
  } finally {
    stopSignal();
    limiter.release();
    if (connector) await connector.close().catch(() => {});
  }
}

module.exports = { replayBatch };
