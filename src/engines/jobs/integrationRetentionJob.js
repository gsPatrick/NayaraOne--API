'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { purgeExpired, readJobHour } = require('../../features/integrations/retention');

/**
 * integrationRetentionJob (Marco 9, M9-D244): uma vez por dia, a partir da hora `integration.retention.job_hour`
 * (America/Sao_Paulo), chama integration.purge_expired() para cada empresa e grava a auditoria com as contagens. O job NÃO
 * apaga nada por conta própria: o role de runtime não tem DELETE nas tabelas de integração. Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 15 * 60 * 1000;
const lastRunDay = new Map();

const spParts = (now) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

/** `force` ignora a hora e o "já rodou hoje" (execução sob demanda e testes). */
async function runIntegrationRetentionJob({ now = new Date(), force = false } = {}) {
  const { day, hour } = spParts(now);
  const summary = { companies: 0, errors: 0, counts: [] };
  const groups = await Group.findAll();
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      const ctx = { groupId: group.id, companyId: company.id };
      try {
        const counts = await tenantTx(group, company, async (transaction) => {
          if (!force && (hour < (await readJobHour(ctx, transaction)) || lastRunDay.get(company.id) === day)) return null;
          return purgeExpired(ctx, transaction);
        });
        if (counts) {
          summary.companies += 1; summary.counts.push({ companyId: company.id, ...counts });
          if (!force) lastRunDay.set(company.id, day);
        }
      } catch (err) {
        summary.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, '[IntegrationRetentionJob] Falha na empresa.');
      }
    }
  }
  return summary;
}

function startIntegrationRetentionJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationRetentionJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err: err.message }, '[IntegrationRetentionJob] Falha na execução agendada.');
    });
  }, tickMs);
}

module.exports = { runIntegrationRetentionJob, startIntegrationRetentionJob };
