'use strict';

const { sequelize, Group, Company } = require('../../models');
const { runAlertCycle, readAlertParams } = require('../../features/integrations/health/alerts');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * integrationAlertJob (Marco 9, M9-D224): a cada `integration.alert.evaluate_interval_s` (padrão 60 s, por empresa) avalia as seis
 * condições de alerta de cada integração (fora do ar, aumento de erro, credencial recusada, credencial perto de vencer, sync parado
 * e cota baixa), abre, repete (antiflap) e resolve os alertas e avisa os papéis configurados com o link do runbook. Também chama o
 * detector de sync parado da M9-D208. O relógio acorda de TICK_MS em TICK_MS; quem decide se a empresa está na hora é o parâmetro dela.
 */
const TICK_MS = 5000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { evaluateIntervalS } = await tenantTx(ctx, (transaction) => readAlertParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= evaluateIntervalS * 1000;
}

async function runIntegrationAlertJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, connections: 0, opened: 0, renotified: 0, resolved: 0, errors: 0 };
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
        const r = await runAlertCycle(ctx, { now });
        summary.companies += 1;
        ['connections', 'opened', 'renotified', 'resolved', 'errors'].forEach((k) => { summary[k] += r[k]; });
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationAlertJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationAlertJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationAlertJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationAlertJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationAlertJob, startIntegrationAlertJob, resetAlertSchedule: () => lastRun.clear() };
