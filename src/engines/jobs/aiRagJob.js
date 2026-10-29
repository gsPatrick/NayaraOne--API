'use strict';

const { sequelize, Group, Company } = require('../../models');
const { processPending } = require('../../features/ai/retrieval');
const { safeLogger } = require('../../features/ai/audit');

/**
 * aiRagJob (Marco 9, M9-D022): a cada passada (1 min) leva à frente as ingestões PENDING do conhecimento homologado (a ingestão é
 * automática: a homologação só cria a linha). A reconciliação dos chunks com a origem entra na M9-D023. Falha de uma empresa não derruba
 * as demais. Roda sobre o nayara_runtime (RLS FORCE por empresa).
 */
const TICK_MS = 60 * 1000;

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

async function runCompany(group, company) {
  const ctx = { groupId: group.id, companyId: company.id };
  const ingested = await tenantTx(group, company, (transaction) => processPending(ctx, transaction));
  return { ingested: ingested.length };
}

/** Uma passada por todas as empresas (ou só as de `companyIds`). */
async function runAiRagJob({ companyIds } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, ingested: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies.filter((c) => !companyIds || companyIds.includes(c.id))) {
      try {
        const r = await runCompany(group, company);
        summary.companies += 1;
        summary.ingested += r.ingested;
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[AiRagJob] falha na empresa');
      }
    }
  }
  if (summary.ingested) safeLogger.info(summary, '[AiRagJob] ingestões do RAG');
  return summary;
}

function startAiRagJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAiRagJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[AiRagJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAiRagJob, startAiRagJob };
