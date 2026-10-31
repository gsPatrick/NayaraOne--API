'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { runBatch } = require('./batch.runner');

/** Registros PENDING da fonte (corrigidos e devolvidos pela decisão REPROCESS da M9-D901), do mais antigo ao mais novo. */
function listPending(tenant, source, limit, transaction) {
  return sequelize.query(
    `SELECT id, source_key, source_payload, updated_at FROM governance.mig_records WHERE company_id = :companyId AND source_system = :system AND entity = :entity AND state = 'PENDING' ORDER BY updated_at, id LIMIT :limit`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, system: source.source_system, entity: source.entity, limit } }
  );
}

/**
 * Processa os registros PENDING da fonte pelo aplicador da M9-D900 (M9-D901 §3.1.1: REPROCESS "entra no próximo lote"). Cada registro vira um evento de atualização já canônico,
 * com posição única `pending:<id>:<instante>` (a chave de idempotência do evento original já foi usada), em lote sem intervalo: não mexe no checkpoint. Quem falha de novo
 * volta a QUARANTINED pela avaliação do destino. Devolve os totais dos lotes rodados.
 */
async function processPending(tenant, actor, runId, source, settings) {
  const totals = { batches: 0, results: [] };
  const seen = new Set();
  for (;;) {
     
    const pending = (await openTenantTx(tenant, (transaction) => listPending(tenant, source, settings.batchSize, transaction))).filter((row) => !seen.has(`${row.id}|${row.updated_at.toISOString()}`));
    if (!pending.length) return totals;
    pending.forEach((row) => seen.add(`${row.id}|${row.updated_at.toISOString()}`));
    const events = pending.map((row) => ({ sourceKey: row.source_key, op: 'U', position: `pending:${row.id}:${row.updated_at.toISOString()}`, record: row.source_payload || {}, canonical: true }));
     
    totals.results.push(await runBatch(tenant, actor, runId, source, { fromToken: null, toToken: null, events }, { settings }));
    totals.batches += 1;
  }
}

module.exports = { processPending, listPending };
