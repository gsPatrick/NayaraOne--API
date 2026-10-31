'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const runsService = require('../ingest/runs.service');
const { executeRun } = require('../ingest/executor');
const { verifyPending } = require('../integrity/verify.job');

/** Uma carga completa: enfileira a execução para todas as fontes, executa e devolve { runId, status, sources }. Execução PAUSED (relógio) ou FAILED sobe como erro da fase. */
async function loadAll(tenant, actor, { lastDelta }) {
  const { runId } = await openTenantTx(tenant, (transaction) => runsService.createRun(tenant, actor, { lastDelta }, transaction));
  const result = await executeRun(tenant, runId);
  const status = result ? result.status : 'UNKNOWN';
  const summary = { runId, status, sources: (result ? result.sources : []).map((item) => ({ source: item.source, entity: item.entity, batches: item.batches, totals: item.totals, error: item.error, paused: item.paused })) };
  if (status !== 'SUCCEEDED') {
    const paused = summary.sources.find((item) => item.paused);
    const failed = summary.sources.find((item) => item.error);
    const err = new Error(paused ? 'Execução pausada: os relógios diferem além do permitido.' : 'A execução da migração não terminou sem erro.');
    err.code = paused ? paused.paused.code : (failed && failed.error.code) || 'GOV_MIG_RUN_NOT_SUCCEEDED';
    err.runId = runId;
    throw err;
  }
  return summary;
}

/**
 * Verificação de hash por lote (D905): leva os lotes APPLIED a VERIFIED ou HASH_MISMATCH. Repete enquanto houver lote APPLIED (cada passada trata um número limitado) e para se
 * uma passada não resolve nenhum lote (lote que falha ao verificar continua APPLIED e vira blocker da Torre).
 */
async function verifyAll(tenant, actor) {
  const total = { verified: 0, mismatched: 0, failed: 0 };
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const results = await verifyPending(tenant, actor);
    const resolved = results.filter((item) => item.status);
    total.verified += results.filter((item) => item.status === 'VERIFIED').length;
    total.mismatched += results.filter((item) => item.status === 'HASH_MISMATCH').length;
    total.failed += results.filter((item) => item.error).length;
    if (!resolved.length) return total;
  }
}

module.exports = { loadAll, verifyAll };
