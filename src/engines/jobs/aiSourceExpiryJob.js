'use strict';

const { sequelize, Group, Company } = require('../../models');
const { expireSources, readRagParams } = require('../../features/ai/retrieval');
const { safeLogger } = require('../../features/ai/audit');

/**
 * aiSourceExpiryJob (Marco 9, M9-D024): a cada `ia.rag.vigencia.intervalo_horas` (padrão 24 h, por empresa) marca EXPIRED o conhecimento
 * homologado e os chunks do RAG cuja vigência terminou. A busca já ignora a fonte vencida pelo relógio; o job deixa o estado coerente.
 * O relógio acorda de TICK_MS em TICK_MS; quem decide se a empresa está na hora é o parâmetro dela. Falha de uma empresa não derruba as
 * demais. Roda sobre o nayara_runtime (RLS FORCE por empresa).
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
    const { expiryHours } = await readRagParams(ctx, transaction);
    const last = lastRun.get(company.id);
    return !last || now.getTime() - last >= expiryHours * 3600 * 1000;
  });
  if (!due) return null;
  lastRun.set(company.id, now.getTime());
  return tenantTx(group, company, (transaction) => expireSources(ctx, transaction, { now }));
}

/** Uma passada por todas as empresas (ou só as de `companyIds`). `force` ignora o intervalo (teste e execução manual). */
async function runAiSourceExpiryJob({ now = new Date(), force = false, companyIds } = {}) {
  if (force) lastRun.clear();
  const groups = await Group.findAll();
  const summary = { companies: 0, knowledge: 0, chunks: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies.filter((c) => !companyIds || companyIds.includes(c.id))) {
      try {
        const r = await runCompany(group, company, now);
        if (r) {
          summary.companies += 1;
          summary.knowledge += r.knowledge;
          summary.chunks += r.chunks;
        }
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[AiSourceExpiryJob] falha na empresa');
      }
    }
  }
  if (summary.knowledge || summary.chunks) safeLogger.info(summary, '[AiSourceExpiryJob] fontes vencidas marcadas como EXPIRED');
  return summary;
}

function startAiSourceExpiryJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAiSourceExpiryJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[AiSourceExpiryJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAiSourceExpiryJob, startAiSourceExpiryJob };
