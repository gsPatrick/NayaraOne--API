'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const targets = require('../ingest/targets');
const results = require('../parallel/results.repository');
const errors = require('./canary.errors');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** A janela iniciada (RUNNING ou CLOSED) mais recente que compara a entidade, e a última execução TERMINADA dela (uma em andamento não conta: vale a anterior). */
async function latestFor(tenant, entity, transaction) {
  const [window] = await select(
    `SELECT id, name, status FROM governance.parallel_windows WHERE company_id = :companyId AND status IN ('RUNNING', 'CLOSED') AND entities @> CAST(:entity AS jsonb)
      ORDER BY starts_at DESC, created_at DESC LIMIT 1`,
    { companyId: tenant.companyId, entity: JSON.stringify([entity]) }, transaction
  );
  if (!window) return null;
  const [run] = await select(
    "SELECT run_number, status FROM governance.parallel_runs WHERE company_id = :companyId AND window_id = :windowId AND status <> 'RUNNING' ORDER BY run_number DESC LIMIT 1",
    { companyId: tenant.companyId, windowId: window.id }, transaction
  );
  return { window, run: run || null };
}

/**
 * Comparação paralela do avanço (M9-D904 §3.3): para cada entidade do setor que a migração sabe carregar, a última comparação terminada da janela mais recente que a cobre
 * precisa estar COMPLETED e sem diferença bloqueante em aberto. Execução FAILED nunca conta como limpa. Entidade sem janela só passa se `migracao.canary.exigir_comparacao`
 * estiver desligado. Entidade do setor sem destino na migração não tem o que comparar.
 */
async function assertClean(tenant, entities, { requireComparison }, transaction) {
  const migratable = new Set(targets.ENTITIES());
  const problems = [];
  for (const entity of entities.filter((name) => migratable.has(name))) {
     
    const found = await latestFor(tenant, entity, transaction);
    if (!found) {
      if (requireComparison) problems.push({ entity, reason: 'NO_COMPARISON' });
      continue;
    }
    if (!found.run || found.run.status !== 'COMPLETED') { problems.push({ entity, reason: found.run ? 'LAST_RUN_FAILED' : 'NO_FINISHED_RUN', windowId: found.window.id }); continue; }
     
    const open = (await results.openBlockers(tenant, found.window.id, transaction)).filter((row) => row.entity === entity);
    if (open.length) throw errors.blockersOpen({ entity, windowId: found.window.id, diffBlockers: open.length });
  }
  if (problems.length) throw errors.comparisonPending({ problems });
}

module.exports = { assertClean, latestFor };
