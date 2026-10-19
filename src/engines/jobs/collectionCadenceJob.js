'use strict';

const { sequelize, Group, Company } = require('../../models');
const { runCollectionCadence } = require('../../features/billing/collectionCadence.service');

/**
 * collectionCadenceJob — executa a régua de cobrança de locação (REG-LOC-004) em todas as
 * empresas. Mesmo padrão de toolLoanOverdueJob: por grupo/empresa, uma transação por empresa com
 * SET LOCAL de tenant (RLS), falha numa empresa não impede as demais. Idempotente: cada etapa
 * roda no máximo uma vez por competência (ver collectionCadence.service.js).
 */

async function processCompany(group, company, now) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return runCollectionCadence(transaction, { now });
  });
}

async function runCollectionCadenceJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, schedulesChecked: 0, executed: 0, skipped: 0, blocked: 0, errors: 0 };

  for (const group of groups) {
    summary.groupsChecked += 1;
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (const company of companies) {
      summary.companiesChecked += 1;
      try {
        const result = await processCompany(group, company, now);
        summary.schedulesChecked += result.schedulesChecked;
        summary.executed += result.executed;
        summary.skipped += result.skipped;
        summary.blocked += result.blocked;
        summary.errors += result.errors;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[CollectionCadenceJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[CollectionCadenceJob] Execução concluída — ${summary.companiesChecked} empresa(s), ${summary.schedulesChecked} competência(s) verificada(s), ` +
      `${summary.executed} etapa(s) executada(s), ${summary.skipped} pulada(s), ${summary.blocked} em acordo/resolvida(s), ${summary.errors} erro(s).`
  );
  return summary;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

function startCollectionCadenceJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runCollectionCadenceJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[CollectionCadenceJob] Falha na execução inicial:', err.message);
  });
  return setInterval(() => {
    runCollectionCadenceJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[CollectionCadenceJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = { runCollectionCadenceJob, startCollectionCadenceJob, processCollectionCadenceForCompany: processCompany };
