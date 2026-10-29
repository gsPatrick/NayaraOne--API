'use strict';

const { sequelize, Group, Company } = require('../../models');
const { processQueued } = require('../../features/ai/evaluations');
const { safeLogger } = require('../../features/ai/audit');

/**
 * aiEvaluationJob (Marco 9, M9-D032): varre as avaliações da NAY que ficaram QUEUED (o processo caiu entre gravar e executar) e
 * as executa, uma transação por avaliação, no provider de testes. O caminho normal é a execução logo após o POST
 * /ai/evaluations/run; este job só recolhe o que sobrou. Falha de uma empresa não derruba as demais. Roda sobre o nayara_runtime.
 */
const TICK_MS = 30 * 1000;

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

/** Uma passada por todas as empresas. Devolve quantas avaliações executou e quantas empresas falharam. */
async function runAiEvaluationJob() {
  const groups = await Group.findAll();
  const summary = { evaluations: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        const done = await tenantTx(group, company, (transaction) => processQueued({ groupId: group.id, companyId: company.id }, transaction));
        summary.evaluations += done.length;
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[AiEvaluationJob] falha na empresa');
      }
    }
  }
  if (summary.evaluations) safeLogger.info(summary, '[AiEvaluationJob] avaliações executadas');
  return summary;
}

function startAiEvaluationJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAiEvaluationJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[AiEvaluationJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAiEvaluationJob, startAiEvaluationJob };
