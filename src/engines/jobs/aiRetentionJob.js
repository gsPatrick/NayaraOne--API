'use strict';

const { sequelize, Group, Company } = require('../../models');
const { purgeExpiredAiContent, readRetentionParams } = require('../../features/ai/retention');
const { safeLogger } = require('../../features/ai/audit');

/**
 * aiRetentionJob (Marco 9, M9-D028): a cada `ia.retencao.intervalo_horas` (padrão 24 h, por empresa) expurga o CONTEÚDO vencido
 * de ai.ai_runs e ai.ai_sources (resumos, argumentos e resultado de ferramentas, trechos) e mantém metadados, custo e hashes.
 * Falha de uma empresa não derruba as demais. O relógio acorda de TICK_MS em TICK_MS; quem decide se a empresa está na hora é o
 * parâmetro dela. Roda sobre o nayara_runtime (RLS FORCE por empresa).
 */
const TICK_MS = 60 * 1000;
const lastRun = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

async function runCompany(group, company, now) {
  const ctx = { groupId: group.id, companyId: company.id };
  const due = await tenantTx(group, company, async (transaction) => {
    const { intervaloHoras } = await readRetentionParams(ctx, transaction);
    const last = lastRun.get(company.id);
    return !last || now.getTime() - last >= intervaloHoras * 3600 * 1000;
  });
  if (!due) return null;
  lastRun.set(company.id, now.getTime());
  return tenantTx(group, company, (transaction) => purgeExpiredAiContent(ctx, transaction, { now }));
}

/** Uma passada por todas as empresas. `force` ignora o intervalo (teste e execução manual). */
async function runAiRetentionJob({ now = new Date(), force = false } = {}) {
  if (force) lastRun.clear();
  const groups = await Group.findAll();
  const summary = { companies: 0, runs: 0, sources: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        const r = await runCompany(group, company, now);
        if (r) {
          summary.companies += 1;
          summary.runs += r.runs;
          summary.sources += r.sources;
        }
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[AiRetentionJob] falha na empresa');
      }
    }
  }
  if (summary.runs || summary.sources) safeLogger.info(summary, '[AiRetentionJob] conteúdo expurgado');
  return summary;
}

function startAiRetentionJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAiRetentionJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[AiRetentionJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAiRetentionJob, startAiRetentionJob };
