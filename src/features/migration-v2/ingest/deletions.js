'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { OPS } = require('./ingest.constants');
const { isoMicros } = require('./tokens');
const records = require('./record.repository');
const { runBatch } = require('./batch.runner');

/**
 * Exclusão na origem para os modos sem evento D (M9-D900 §3.3): compara as chaves vivas do destino com as que a origem ainda tem e marca como `source_deleted` as ausentes
 * (exclusão lógica; nada é apagado). Cada pacote de chaves passa pelo mesmo caminho de lote (checkpoint não muda, hash e auditoria iguais). Devolve a quantidade marcada.
 * WATERMARK não enxerga exclusões: a "última carga delta" (M9-D902) chama esta função; FULL_DIFF a chama em toda execução.
 */
async function markMissingKeys(tenant, actor, runId, source, connector, settings) {
  const present = new Set(await connector.listKeys());
  const live = await openTenantTx(tenant, (transaction) => records.listLiveKeys(tenant, source, transaction));
  const missing = live.filter((key) => !present.has(key));
  const stamp = isoMicros(new Date());
  for (let i = 0; i < missing.length; i += settings.batchSize) {
    const events = missing.slice(i, i + settings.batchSize).map((sourceKey) => ({ sourceKey, op: OPS.DELETE, position: `DEL:${stamp}` }));
     
    await runBatch(tenant, actor, runId, source, { fromToken: null, toToken: null, events }, { settings });
  }
  return missing.length;
}

module.exports = { markMissingKeys };
