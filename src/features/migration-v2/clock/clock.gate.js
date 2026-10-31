'use strict';

const clock = require('./clock.service');
const errors = require('./clock.errors');

/**
 * Antes de cada lote (M9-D908 §3.1): confere os relógios; acima do limite o aplicador pausa (o erro GOV_MIG_CLOCK_DRIFT sobe até o executor, que marca a execução PAUSED sem
 * perder o checkpoint). `connector` é o da fonte que vai ler, já aberto, para a conferência não abrir outra conexão ao legado a cada lote.
 */
async function beforeBatch(tenant, { runId, source, connector }) {
  const result = await clock.check(tenant, {
    context: 'BATCH', runId, connectors: connector && source ? [{ system: source.source_system, connector }] : undefined,
  });
  if (result.status === clock.STATUS.OK) return result;
  const details = { driftMs: result.driftMs, maxDriftMs: result.maxDriftMs, systems: result.readings.map((reading) => ({ system: reading.system, offsetMs: reading.offsetMs, error: reading.error })) };
  throw result.status === clock.STATUS.DRIFT ? errors.drift(details) : errors.unmeasured(details);
}

/** O erro é de relógio (a execução pausa em vez de falhar)? */
const isClockPause = (err) => Boolean(err) && (err.code === 'GOV_MIG_CLOCK_DRIFT' || err.code === 'GOV_MIG_CLOCK_UNMEASURED');

module.exports = { beforeBatch, isClockPause };
