'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const logger = require('../../../utils/logger');
const windows = require('./window.repository');
const { tickWindow } = require('./runner');
const tower = require('../control/tower.service');

/**
 * parallelCompareJob por empresa (M9-D903 §5): olha as janelas SCHEDULED e RUNNING e roda a comparação das que estão na hora; depois de cada execução concluída leva as
 * diferenças à Torre de controle (abre e fecha os blockers). Janela com diferença aberta continua a rodar após o `ends_at`; sem diferença, fecha. Devolve o resumo da volta.
 */
async function runParallelCompare(tenant, { now = new Date() } = {}) {
  const total = { windows: 0, runs: 0, failed: 0, closed: 0 };
  const active = await openTenantTx(tenant, (transaction) => windows.listActive(tenant, transaction));
  for (const window of active) {
    total.windows += 1;
    try {
       
      const outcome = await tickWindow(tenant, window.id, { now });
      if (outcome.action === 'COMPLETED') {
        total.runs += 1;
        if (outcome.closed) total.closed += 1;
      } else if (outcome.action === 'FAILED') total.failed += 1;
      if (outcome.action !== 'SKIPPED') {
         
        await openTenantTx(tenant, (transaction) => tower.getTower(tenant, { userId: null }, {}, transaction));
      }
    } catch (err) {
      total.failed += 1;
      logger.error({ windowId: window.id, err: err.message }, 'migration.parallel.job.window.failed');
    }
  }
  return total;
}

module.exports = { runParallelCompare };
