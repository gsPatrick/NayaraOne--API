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
  const connector = await connectors.open(source);
  try {
    const range = { fromToken: original.from_token, toToken: original.to_token };
    let events;
    if (source.mode === MODES.CDC) events = await cdc.readRange(connector, range);
    else if (source.mode === MODES.WATERMARK) events = await watermark.readRange(connector, range);
    else events = await fulldiff.readRange(connector, source, range);
    return await runBatch(tenant, actor, original.run_id, source, { ...range, events }, { replayOf: original.id, settings });
  } finally {
    await connector.close().catch(() => {});
  }
}

module.exports = { replayBatch };
