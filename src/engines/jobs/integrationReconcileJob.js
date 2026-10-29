'use strict';

const { sequelize, Group, Company } = require('../../models');
const { reconcileDue, readReconcileParams } = require('../../features/integrations/dispatch/reconcile');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * integrationReconcileJob (Marco 9, M9-D215): consulta o fornecedor sobre os envios em UNKNOWN (timeout depois do envio) cuja espera
 * passou (30 s, 2 min, 10 min, 1 h e 6 h por padrão) e resolve, repete com a mesma chave ou, esgotadas as consultas, manda à revisão humana.
 * O relógio acorda de TICK_MS em TICK_MS; quem decide se a empresa está na hora é `integration.unknown.reconcile_job_interval_s`.
 */
const TICK_MS = 1000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { jobIntervalS } = await tenantTx(ctx, (transaction) => readReconcileParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= jobIntervalS * 1000;
}

async function runIntegrationReconcileJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, due: 0, reconciled: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      const ctx = { groupId: group.id, companyId: company.id };
      try {
        if (!(await isDue(ctx, now))) continue;
        lastRun.set(company.id, now.getTime());
        const r = await reconcileDue(ctx, { now });
        summary.companies += 1;
        ['due', 'reconciled', 'errors'].forEach((k) => { summary[k] += r[k]; });
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationReconcileJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationReconcileJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationReconcileJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationReconcileJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationReconcileJob, startIntegrationReconcileJob, resetReconcileSchedule: () => lastRun.clear() };
