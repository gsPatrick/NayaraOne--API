'use strict';

const { sequelize, Group, Company } = require('../../models');
const { rolloverCompany, monthPeriodOf } = require('../../features/ai/budgets');
const { safeLogger } = require('../../features/ai/audit');

/**
 * aiBudgetPeriodJob (Marco 9, M9-D014): na virada do mês (00:00 de America/Sao_Paulo) abre, para cada empresa, a nova linha de
 * orçamento copiando limites, limiares, ação e status; o consumo recomeça em 0 e os alertas rearmam (UNIQUE inclui period_start).
 * O relógio acorda de minuto em minuto; cada empresa é feita uma vez por mês. A leitura/gate também abre a linha sob demanda
 * (ensureCurrentPeriod), então atraso do job nunca deixa a empresa sem orçamento. Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 60 * 1000;
const doneForMonth = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

/** Uma passada por todas as empresas. `force` ignora o "já feito neste mês" (teste e execução manual). */
async function runAiBudgetPeriodJob({ now = new Date(), force = false } = {}) {
  if (force) doneForMonth.clear();
  const monthKey = monthPeriodOf(now).start.toISOString();
  const summary = { companies: 0, created: 0, errors: 0 };
  const groups = await Group.findAll();
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      if (doneForMonth.get(company.id) === monthKey) continue;
      try {
        const ctx = { groupId: group.id, companyId: company.id };
        const r = await tenantTx(group, company, (transaction) => rolloverCompany(ctx, transaction, { now }));
        doneForMonth.set(company.id, monthKey);
        summary.companies += 1;
        summary.created += r.created;
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[AiBudgetPeriodJob] falha na empresa');
      }
    }
  }
  if (summary.created) safeLogger.info(summary, '[AiBudgetPeriodJob] orçamentos do novo período abertos');
  return summary;
}

function startAiBudgetPeriodJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAiBudgetPeriodJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[AiBudgetPeriodJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAiBudgetPeriodJob, startAiBudgetPeriodJob };
