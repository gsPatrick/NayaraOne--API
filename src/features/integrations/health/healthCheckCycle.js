'use strict';

const { IntegrationConnection } = require('../../../models');
const { tenantTx } = require('../dispatch/worker/tenantTx');
const { runConnectionHealthCheck } = require('./healthCheckRun');

/**
 * Uma rodada de testes de saúde para UMA empresa (M9-D223 3.1): toda connection ACTIVE (inclusive com o circuito em OPEN, para
 * detectar a recuperação). Falha de uma connection não derruba as outras. Devolve { checked, ok, failed, skipped, results }.
 */
async function runHealthCheckCycle(ctx, { now = new Date() } = {}) {
  const ids = await tenantTx(ctx, async (transaction) => (await IntegrationConnection.findAll({
    where: { companyId: ctx.companyId, status: 'ACTIVE' }, order: [['created_at', 'ASC'], ['id', 'ASC']], attributes: ['id'], transaction,
  })).map((c) => c.id));
  const resumo = { checked: 0, ok: 0, failed: 0, skipped: 0, results: [] };
  for (const id of ids) {
    const r = await runConnectionHealthCheck(ctx, id, { now });
    resumo.results.push({ connectionId: id, ...r });
    if (r.status !== 'CHECKED') resumo.skipped += 1;
    else { resumo.checked += 1; resumo[r.ok ? 'ok' : 'failed'] += 1; }
  }
  return resumo;
}

module.exports = { runHealthCheckCycle };
