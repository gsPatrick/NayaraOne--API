'use strict';

const { Group, Company, sequelize } = require('../../models');
const logger = require('../../utils/logger');
const { openTenantTx } = require('../../features/core-governance/data-quality/retention.tenantTx');
const runs = require('../../features/migration-v2/ingest/run.repository');
const { executeRun } = require('../../features/migration-v2/ingest/executor');
const { recount } = require('../../features/migration-v2/control/counters.service');
const { purgePayloads } = require('../../features/migration-v2/ingest/payload.purge');
const { verifyPending } = require('../../features/migration-v2/integrity/verify.job');

/**
 * migrationRunJob (M9-D900 §5 e M9-D901 §6) — retoma as execuções QUEUED da migração v2 (POST /migration/runs) cuja partida imediata se perdeu (processo reiniciado) e refaz os
 * contadores da Torre de controle que divergirem da contagem direta. Confere a cada minuto,
 * empresa por empresa; a execução é reivindicada de forma atômica, então duas instâncias nunca rodam a mesma. Desligar no processo: MIGRATION_RUN_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;

async function runMigrationRunJob() {
  const total = { companies: 0, runs: 0, verified: 0, counters: 0, purged: 0, errors: 0 };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      const tenant = { groupId: group.id, companyId: company.id };
      try {
         
        const queued = await openTenantTx(tenant, (transaction) => runs.listQueued(tenant, transaction));
        for (const run of queued) {
           
          if (await executeRun(tenant, run.id)) total.runs += 1;
        }
        // Verificação dos lotes APPLIED (M9-D905): raiz Merkle do destino contra a da origem.
         
        total.verified += (await verifyPending(tenant, { userId: null })).length;
        // Conferência dos contadores da Torre de controle (M9-D901 §6): só mexe se a contagem direta divergir dos contadores materializados.
         
        total.counters += (await openTenantTx(tenant, (transaction) => recount(tenant, transaction))).corrected;
        // Descarte do conteúdo de origem dos registros reconciliados há mais que o prazo (LGPD, M9-D900).
        total.purged += await openTenantTx(tenant, (transaction) => purgePayloads(tenant, transaction));
      } catch (err) {
        total.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, 'migrationRunJob.company.failed');
      }
    }
  }
  if (total.runs || total.verified || total.counters || total.purged || total.errors) logger.info(total, 'migrationRunJob.run');
  return total;
}

function startMigrationRunJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runMigrationRunJob(); } catch (err) { logger.error({ err: err.message }, 'migrationRunJob.failed'); } finally { running = false; }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runMigrationRunJob, startMigrationRunJob };
