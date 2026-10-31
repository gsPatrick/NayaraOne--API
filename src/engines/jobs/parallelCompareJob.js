'use strict';

const { Group, Company, sequelize } = require('../../models');
const logger = require('../../utils/logger');
const { runParallelCompare } = require('../../features/migration-v2/parallel/parallel.job');

/**
 * parallelCompareJob (M9-D903 §5) — confere a cada minuto, empresa por empresa, as janelas de comparação paralela antigo x novo: roda a comparação das que estão na hora
 * (intervalo da janela), abre e fecha os blockers da Torre e fecha a janela quando acaba o prazo sem diferença. Desligar no processo: PARALLEL_COMPARE_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;

async function runParallelCompareJob() {
  const total = { companies: 0, windows: 0, runs: 0, failed: 0, closed: 0 };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      try {
         
        const one = await runParallelCompare({ groupId: group.id, companyId: company.id });
        for (const key of ['windows', 'runs', 'failed', 'closed']) total[key] += one[key];
      } catch (err) {
        total.failed += 1;
        logger.error({ companyId: company.id, err: err.message }, 'parallelCompareJob.company.failed');
      }
    }
  }
  if (total.runs || total.failed || total.closed) logger.info(total, 'parallelCompareJob.run');
  return total;
}

function startParallelCompareJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runParallelCompareJob(); } catch (err) { logger.error({ err: err.message }, 'parallelCompareJob.failed'); } finally { running = false; }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runParallelCompareJob, startParallelCompareJob };
